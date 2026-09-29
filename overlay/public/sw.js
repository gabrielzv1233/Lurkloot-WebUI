self.addEventListener("push", (event) => {
  let payload = {
    title: "Lurkloot",
    body: "Lurkloot has an update.",
    url: "/",
  };

  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-128.png",
      badge: "/icon-128.png",
      data: { url: payload.url || "/" },
      tag: payload.tag,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      for (const client of windows) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          if ("navigate" in client) await client.navigate(target);
          return client.focus();
        }
      }

      if (clients.openWindow) return clients.openWindow(target);
      return undefined;
    }),
  );
});
