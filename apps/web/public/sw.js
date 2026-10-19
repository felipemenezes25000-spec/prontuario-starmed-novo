const CACHE='starmed-shell-v1';
self.addEventListener('install', e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/'])));self.skipWaiting();});
self.addEventListener('activate', e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch', e=>{
  const url=new URL(e.request.url);
  if(e.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||e.request.headers.has('Authorization')) return;
  e.respondWith(fetch(e.request).then(resp=>{
    if(resp.ok && (url.pathname==='/'||/\.(js|css|svg|png|woff2?)$/.test(url.pathname))){
      const copy=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));
    }
    return resp;
  }).catch(()=>caches.match(e.request)));
});
