/* عامل الخدمة: يجعل موقع شرائح الحروف يعمل بالكامل دون اتصال بعد أول زيارة */
const CACHE = 'huruf-offline-v1';
const CORE = [
  './',
  './index.html',
  './audio/manifest.json',
  './fonts/baloo-arabic.woff2',
  './fonts/baloo-latin.woff2'
];

let audioListPromise = null;
let cachingAll = null;

function getAudioList() {
  if (audioListPromise) return audioListPromise;
  audioListPromise = (async () => {
    let res = await caches.match('audio/manifest.json', { ignoreSearch: true });
    if (!res) res = await fetch('audio/manifest.json', { cache: 'no-store' });
    if (!res || !res.ok) throw new Error('manifest unavailable');
    const m = await res.json();
    return (m.keys || []).map(k => 'audio/' + k + '.mp3');
  })().catch(() => []);
  return audioListPromise;
}

async function notify(data) {
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    clients.forEach(c => { try { c.postMessage(data); } catch (e) {} });
  } catch (e) {}
}

async function cacheAll() {
  if (cachingAll) return cachingAll;
  cachingAll = (async () => {
    const files = await getAudioList();
    const total = files.length;
    if (!total) { cachingAll = null; return false; }
    const cache = await caches.open(CACHE);
    let next = 0, done = 0, lastPost = 0;
    const failed = [];

    await notify({ type: 'CACHE_PROGRESS', done: 0, total });

    const worker = async () => {
      while (next < files.length) {
        const f = files[next++];
        let ok = false;
        try {
          if (await cache.match(f)) ok = true;
          else {
            const res = await fetch(f, { cache: 'no-cache' });
            if (res && res.ok) { await cache.put(f, res); ok = true; }
          }
        } catch (e) {}
        if (!ok) failed.push(f);
        done++;
        if (done - lastPost >= 20 || done === total) {
          lastPost = done;
          await notify({ type: 'CACHE_PROGRESS', done, total });
        }
      }
    };

    await Promise.all(Array.from({ length: 6 }, worker));

    /* محاولة ثانية للملفات التي فشل تنزيلها */
    for (const f of failed) {
      try {
        if (!(await cache.match(f))) {
          const res = await fetch(f, { cache: 'reload' });
          if (res && res.ok) await cache.put(f, res);
        }
      } catch (e) {}
    }

    /* عدّ ما تم حفظه فعليًا */
    let cached = 0;
    for (const f of files) {
      if (await cache.match(f)) cached++;
    }

    cachingAll = null;
    await notify({ type: 'CACHE_DONE', total, cached, complete: cached === total });
    return cached === total;
  })().catch(async e => {
    cachingAll = null;
    await notify({ type: 'CACHE_DONE', total: 0, cached: 0, complete: false });
    return false;
  });
  return cachingAll;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(CORE.map(url =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.indexOf('huruf-offline-') === 0 && k !== CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const d = event.data || {};
  if (d.type === 'CACHE_ALL') {
    event.waitUntil(cacheAll());
  } else if (d.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return; // لا نتدخل في أي طلب خارجي
  if (url.pathname.endsWith('/sw.js')) return; // يُحدَّث عامل الخدمة من المتصفح مباشرة

  /* صفحات الموقع: الشبكة أولًا ثم النسخة المحفوظة */
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok && res.status < 500) {
          const cache = await caches.open(CACHE);
          cache.put('./index.html', res.clone()).catch(() => {});
          return res;
        }
        throw new Error('network response ' + (res && res.status));
      } catch (e) {
        const cache = await caches.open(CACHE);
        return (await cache.match(req, { ignoreSearch: true }))
          || (await cache.match('./index.html'))
          || (await cache.match('./'))
          || new Response('الموقع غير محفوظ بعد للعمل دون اتصال.', {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
      }
    })());
    return;
  }

  /* بقية الملفات (الأصوات والخطوط): النسخة المحفوظة أولًا */
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.ok && res.status === 200) {
        const cache = await caches.open(CACHE);
        await cache.put(req, res.clone()).catch(() => {});
        return res;
      }
      throw new Error('network response ' + (res && res.status));
    } catch (e) {
      return new Response('', { status: 503 });
    }
  })());
});
