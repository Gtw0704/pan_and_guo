// Service Worker - 支持后台通知 & 离线缓存
const CACHE = 'ldr-hub-v2';
const ASSETS = ['./', './index.html', './manifest.json', './sw.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const req = e.request;
  const isPage = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  if (isPage) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const cloned = res.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', cloned));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const cloned = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, cloned));
        return res;
      });
    })
  );
});

// 收到来自页面的消息，显示系统通知（网页还开着/在后台常驻内存时走这条路）
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag } = e.data;
    self.registration.showNotification(title || '我们的小窝', {
      body: body || '有新的更新',
      icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E💕%3C/text%3E%3C/svg%3E",
      badge: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E💕%3C/text%3E%3C/svg%3E",
      tag: tag || 'ldr-update',
      renotify: true,
      vibrate: [120, 60, 120],
      data: { url: './index.html' }
    });
  }
});

// 真正的 Web Push：网站完全关闭、甚至没在后台运行时，操作系统会短暂唤醒这个 Service Worker
// 来触发这个事件——这就是"网站完全关闭也能收到通知"依赖的底层机制。
// 推送服务器（push-worker.js）发来的内容是 { title, body }，跟上面 message 事件走的是同一套通知样式。
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  const title = (data.notification && data.notification.title) || data.title || '我们的小窝';
  const body = (data.notification && data.notification.body) || data.body || '有新的更新';
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E💕%3C/text%3E%3C/svg%3E",
      badge: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E💕%3C/text%3E%3C/svg%3E",
      tag: 'ldr-push',
      renotify: true,
      vibrate: [120, 60, 120],
      data: { url: './index.html' }
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow('./index.html');
    })
  );
});
