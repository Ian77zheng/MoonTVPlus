import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { ensureQuarkPlayFolder, getQuarkPlayHeaders, getQuarkPlayUrls, saveQuarkShareFile } from '@/lib/netdisk/quark.client';
import { refreshQuarkNetdiskSession } from '@/lib/netdisk/quark-session-cache';
import { resolveQuarkSession } from '@/lib/netdisk/quark-session-resolver';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo?.username) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const episodeIndexRaw = searchParams.get('episodeIndex');
    const quality = searchParams.get('quality') || '';
    if (!id || episodeIndexRaw == null) {
      return NextResponse.json({ error: '缺少参数' }, { status: 400 });
    }

    const episodeIndex = Number.parseInt(episodeIndexRaw, 10);
    if (!Number.isInteger(episodeIndex) || episodeIndex < 0) {
      return NextResponse.json({ error: '无效的 episodeIndex' }, { status: 400 });
    }

    const { session, cookie, savePath, playMode } = await resolveQuarkSession(id);
    const file = session.files[episodeIndex];
    if (!file) {
      return NextResponse.json({ error: '播放文件不存在' }, { status: 404 });
    }

    if (!session.playFolderFid || !session.playFolderPath) {
      const folder = await ensureQuarkPlayFolder(cookie, savePath, session.shareId, session.title);
      session.playFolderFid = folder.folderFid;
      session.playFolderPath = folder.folderPath;
    }

    let savedFileId = session.savedFileIds[file.fid];
    if (!savedFileId) {
      savedFileId = await saveQuarkShareFile(cookie, {
        shareId: session.shareId,
        shareToken: session.shareToken,
        fileId: file.fid,
        shareFileToken: file.shareFidToken,
        playFolderFid: session.playFolderFid,
      });
      session.savedFileIds[file.fid] = savedFileId;
    }
    refreshQuarkNetdiskSession(id);

    const playUrls = await getQuarkPlayUrls(cookie, savedFileId, playMode);
    const selected = playUrls.find((item) => item.name === quality) || playUrls[0];
    const candidates = selected
      ? [
          selected,
          ...playUrls.filter((item) => item.url !== selected.url),
        ]
      : [];
    if (candidates.length === 0) {
      return NextResponse.json({ error: '未获取到夸克播放地址' }, { status: 500 });
    }

    const range = request.headers.get('range');
    const passthroughHeaderNames = [
      'accept',
      'accept-language',
      'accept-encoding',
      'connection',
      'sec-fetch-dest',
      'sec-fetch-mode',
      'sec-fetch-site',
    ];
    const passthroughHeaders: Record<string, string> = {};
    for (const name of passthroughHeaderNames) {
      const value = request.headers.get(name);
      if (value) passthroughHeaders[name] = value;
    }

    try {
      let upstream: Response | null = null;
      let lastStatus = 500;
      const headerProfiles = [
        {
          name: 'quark-empty-ua',
          headers: {
            ...passthroughHeaders,
            ...getQuarkPlayHeaders(cookie),
          },
        },
        {
          name: 'quark-api-ua',
          headers: {
            ...passthroughHeaders,
            cookie,
            referer: 'https://pan.quark.cn/',
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch',
          },
        },
        {
          name: 'quark-no-ua',
          headers: {
            ...passthroughHeaders,
            cookie,
            referer: 'https://pan.quark.cn/',
          },
        },
        {
          name: 'browser-origin',
          headers: {
            ...passthroughHeaders,
            cookie,
            origin: 'https://pan.quark.cn',
            referer: 'https://pan.quark.cn/',
            'user-agent':
              request.headers.get('user-agent') ||
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
          },
        },
      ];

      for (const candidate of candidates) {
        for (const profile of headerProfiles) {
          const abortController = new AbortController();
          const timeoutId = setTimeout(() => abortController.abort(), 300000);

          try {
            const requestHeaders = {
              ...profile.headers,
              ...(range ? { Range: range } : {}),
            };
            const response = await fetch(candidate.url, {
              headers: requestHeaders,
              cache: 'no-store',
              signal: abortController.signal,
            });

            clearTimeout(timeoutId);
            if (response.ok && response.body) {
              upstream = response;
              if (candidate.url !== selected.url) {
                console.warn(`[quark] fallback play url used: ${selected.name} -> ${candidate.name}`);
              }
              if (profile.name !== 'quark-empty-ua') {
                console.warn(`[quark] fallback header profile used: ${profile.name}`);
              }
              break;
            }

            lastStatus = response.status || 500;
            const errorText = await response.text().catch(() => '');
            console.warn(
              `[quark] play url failed: ${candidate.name} / ${profile.name} (${lastStatus}) ${errorText.slice(0, 200)}`
            );
          } catch (error) {
            clearTimeout(timeoutId);
            if (error instanceof Error && error.name === 'AbortError') {
              throw error;
            }
            console.warn(`[quark] play url request failed: ${candidate.name} / ${profile.name}`, error);
          }
        }

        if (upstream) {
          break;
        }
      }

      if (!upstream) {
        return NextResponse.json(
          { error: `夸克视频代理失败 (${lastStatus})` },
          { status: lastStatus }
        );
      }

      const response = upstream as Response & { body: ReadableStream<Uint8Array> };
      const responseHeaders = new Headers();
      const copyHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
      copyHeaders.forEach((name) => {
        const value = response.headers.get(name);
        if (value) responseHeaders.set(name, value);
      });
      responseHeaders.set('Cache-Control', 'private, no-store');

      const { readable, writable } = new TransformStream();
      const reader = response.body.getReader();

      void (async () => {
        const writer = writable.getWriter();
        try {
          let streamDone = false;
          while (!streamDone) {
            const { done, value } = await reader.read();
            if (done) {
              streamDone = true;
            } else {
              await writer.write(value);
            }
          }
        } catch {
          try {
            await reader.cancel();
          } catch {
            void 0;
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            void 0;
          }
          try {
            await writer.close();
          } catch {
            void 0;
          }
        }
      })();

      return new Response(readable, {
        status: range && response.headers.get('content-range') ? 206 : response.status,
        headers: responseHeaders,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return NextResponse.json({ error: '夸克网盘代理超时' }, { status: 504 });
      }
      throw error;
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '夸克网盘代理失败' },
      { status: 500 }
    );
  }
}
