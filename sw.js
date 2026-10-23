/* 업무포털 서비스워커 — 일일 보고서 폰 알림(웹 푸시) 전용. 화면 캐시는 하지 않음(항상 최신 포털을 불러옴) */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '업무포털 알림', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/badge-72.png',
    tag: d.tag || 'yum', renotify: true, data: { url: d.url || './#/reports' }
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || './#/reports', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) { c.postMessage({ url: url }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
