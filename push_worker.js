// ============================================================
// push-worker.js —— 部署到 Cloudflare Workers（免费）
// 作用：网站本身不能直接发送推送通知（会暴露一个不能公开的密钥），
// 这个小服务负责安全地保管密钥、代替网站把推送真正发出去。
//
// 部署后，网站需要知道这个 Worker 的访问地址，把它填进 index.html 的
// PUSH_CONFIG.triggerUrl 里（详见 README「推送通知」章节的部署步骤）。
//
// 需要在 Cloudflare Worker 的 Settings → Variables and Secrets 里配置三个 Secret
//（在网页控制台点点鼠标就行，不要把这三个值写进代码里）：
//   FCM_PROJECT_ID    Firebase 项目 ID（跟 index.html 里 FIREBASE_CONFIG.projectId 一样）
//   FCM_CLIENT_EMAIL  服务账号的 client_email（从 Firebase 服务账号 JSON 文件里复制）
//   FCM_PRIVATE_KEY   服务账号的 private_key（从同一个 JSON 文件里复制，保留原始的换行）
// ============================================================

// 建议部署后把这里改成你自己网站的地址（比如 'https://yourname.github.io'），
// 而不是保持 '*'，这样只有你自己的网站能调用这个 Worker。
const ALLOWED_ORIGIN = 'https://gtw0704.github.io/pan_and_guo/';

function base64UrlEncode(bytes) {
  let str = typeof bytes === 'string' ? btoa(bytes) : btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return str.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// 用服务账号的私钥签一个 JWT，去 Google 换一个短期有效的 access token
async function getAccessToken(env) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: env.FCM_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claim))}`;

  // PEM 格式的私钥去掉头尾和换行，转成二进制交给 WebCrypto
  const pemBody = env.FCM_PRIVATE_KEY.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const binaryKey = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64UrlEncode(signature)}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('获取 access token 失败: ' + JSON.stringify(data));
  return data.access_token;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() });
    }

    try {
      const { token, title, body } = await request.json();
      if (!token || !title) {
        return new Response(JSON.stringify({ error: '缺少 token 或 title' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      const accessToken = await getAccessToken(env);
      const fcmResp = await fetch(
        `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: {
              token,
              webpush: {
                notification: {
                  title,
                  body: body || '有新的更新',
                  icon:
                    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%92%95%3C/text%3E%3C/svg%3E"
                },
                fcm_options: {}
              }
            }
          })
        }
      );

      const result = await fcmResp.json();
      return new Response(JSON.stringify(result), {
        status: fcmResp.ok ? 200 : 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e && e.message ? e.message : e) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
  }
};
