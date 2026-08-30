# pan_and_guo · 小盘子 & 小果子的小窝

一个给异地恋情侣用的单页 PWA 网站。纯静态（HTML + 内联 JS + Tailwind CDN），部署在 GitHub Pages 上，
两人的数据通过 Firebase Realtime Database 实时同步。

**这份 README 是写给以后接手改代码的人（人类或 AI）看的**，目的是让你不用重新读一遍 1300 多行代码就能知道
"这个功能在哪、怎么改、改的时候要注意什么"。产品文案（给情侣看的话）请看代码里的中文字符串本身，这里只讲工程结构。

---

## 1. 文件结构

```
index.html      唯一的主文件，页面结构 + 样式 + 全部逻辑都在这一个文件里（没有构建步骤）
manifest.json   PWA manifest，定义应用名、图标、启动方式
sw.js           Service Worker：离线缓存 + 网页打开时的通知 + 网页关闭也能收到的 Web Push
push-worker.js  部署到 Cloudflare Workers 的推送服务器，不随 GitHub Pages 一起发布，见第 12 节
README.md       本文件
```

没有 `package.json`，没有构建工具，`index.html`/`manifest.json`/`sw.js` 都没有后端代码，改完直接 git push，GitHub Pages 会自动发布。`push-worker.js` 是唯一的例外——它需要单独部署到 Cloudflare（免费），因为它保管着一个不能公开的密钥，绝不能跟其他文件一起放进公开的 GitHub Pages 里，见第 12 节。

---

## 2. 技术栈 / 外部依赖

全部通过 CDN 引入，没有 npm：

- **Tailwind CDN**（`cdn.tailwindcss.com`）—— 所有样式用 Tailwind class 写，`tailwind.config` 在 `<head>` 里内联扩展了自定义颜色（blush/cream/lavender/soft）和动画（float / pulse-soft / heart-burst / fade-in）。
- **Lucide icons**（`unpkg.com/lucide`）—— 图标库，`lucide.createIcons()` 在 `init()` 里调用一次，渲染所有 `<i data-lucide="...">`。
- **Google Fonts**：Inter（正文）+ Playfair Display（`font-display`，标题用）。
- **Firebase v11 modular SDK**（`gstatic.com/firebasejs/11.0.2`）—— 只用了 `firebase-app` 和 `firebase-database` 两个子包，通过 `<script type="module">` 引入后挂到 `window.firebaseMods`，方便普通 `<script>` 里调用（因为普通 script 不能用 `import`）。
- **Open-Meteo API**（`api.open-meteo.com`）—— 免费天气 API，不需要 key。

---

## 2.1 刘海屏 / 灵动岛适配

`<meta viewport>` 里加了 `viewport-fit=cover`，这是让 CSS 里的 `env(safe-area-inset-*)` 真正生效的开关，缺了它安全区变量恒为 0，写了也没用。
安全区内边距不是加在 `body` 上，而是分别加在 `header.app-header`（`padding-top`）和 `footer.app-footer`（`padding-bottom`）——
因为 header 是 `sticky top-0`，如果把内边距放在 body 上，吸顶滚动之后 header 会滚到状态栏/刘海下面被裁切，所以要让 header 自己扛这段安全区高度。
`body` 上留了左右安全区（`padding-left/right`），应对横屏时刘海挡住内容左右两侧的情况。

## 3. 云端同步架构（最重要，务必先读）

### 3.1 现状：写死配置，零手动操作

以前的版本要求两人各自在浏览器里粘贴 Firebase 配置，很容易忘记怎么弄。**现在改成了「维护者填一次代码里的常量，之后所有人打开网站都自动连上」**，具体见 `index.html` 里的：

```js
const FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  databaseURL: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};
function isFirebaseConfigured() {
  return !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.databaseURL);
}
```

- 只要 `FIREBASE_CONFIG.apiKey` 和 `databaseURL` 不是空字符串，页面加载时会**自动**调用 `initFirebase(FIREBASE_CONFIG)`，不需要任何人点按钮、粘贴任何东西。
- 如果这两个字段还是空的（比如全新 clone 下来的仓库还没配置），页面会退化成"本机模式"：数据只存 `localStorage`，不会跨设备同步，并且会在页面顶部显示一个 `#dev-setup-notice` 的提示条——**这个提示条是给维护者看的，不是给小盘子/小果子看的**，正常用户看到它就说明网站还没配置好。
- 获取 Firebase 配置的步骤写在 `FIREBASE_CONFIG` 常量正上方的注释里，简单说就是：Firebase 控制台建一个免费项目 → 开 Realtime Database（测试模式）→ 注册一个 Web 应用 → 复制那段 config 对象粘进来。
- 因为这是纯静态站点、仓库是公开的，任何写在前端里的 key 本来就不是秘密，所以"写死在代码里"和"用户手动填"在安全性上没有本质区别，但极大简化了使用体验。

### 3.2 数据流

- **本地优先**：任何修改都先调用 `saveLocal()` 写入 `localStorage`（key: `ldr_hub_v3_panzi_guozi`），保证离线也能用、刷新不丢数据。
- **推送到云端**：`saveState()` = `saveLocal()` + `pushToCloud()`。`pushToCloud()` 有 400ms 防抖（`saveTimeout`），把整个 `state` 对象整体 `set()` 到 Firebase 的 `couples/panzi-guozi` 路径（`DB_PATH` 常量）。**注意：是整体覆盖写入，不是增量 patch**，所以理论上如果两人在同一秒内分别改了不同字段，后写的会覆盖先写的（这个 app 目前没做冲突合并，规模小、使用场景是异步为主，暂时没做也够用，但如果以后要支持"多人同时疯狂编辑"就要重新设计成按字段写入）。
- **接收云端更新**：`onValue(dbRef, ...)` 建立实时监听，云端一变就会触发 `applyRemoteData()`。此外还有兜底机制：
  - `startCloudPolling()`：每 12 秒主动 `get()` 一次做兜底轮询（防止 onValue 漏推送）。
  - `visibilitychange` 监听：页面从后台切回前台时主动拉一次最新数据。
  - `window online/offline` 事件：更新顶部的同步状态小圆点文字。
- **`isRemoteUpdate` 标志位很关键**：应用远程数据时会先设 `isRemoteUpdate = true`，防止 `applyRemoteData()` 里调用的渲染函数又触发一轮 `saveState()` 导致死循环写回云端。改代码时如果新增"渲染时也会写状态"的逻辑，一定要留意这个标志位。

### 3.3 同步状态指示器

顶部的小圆点（`#sync-dot`）+ 文字（`#sync-status`），由 `setSyncStatus(status, text)` 统一控制，`status` 只有三种：`online`（绿）/ `offline`（红）/ `syncing`（黄，闪烁）。所有跟连接相关的状态变化都应该调这个函数，不要直接改 DOM。

---

## 4. 数据模型（`state` 对象 / `defaultState`）

这是整个 app 唯一的状态对象，全局变量 `state`，同时存在 `localStorage` 和 Firebase 里。改需求时先看这里，通常新功能 = 在这个对象里加一个字段 + 一个 render 函数 + 挂到 `renderAll()`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `startTogether` | `"YYYY-MM-DD"` | 在一起纪念日，用于首页"在一起 N 天"计数 |
| `startApart` | `"YYYY-MM-DD"` | 异地开始日，用于"异地 N 天"计数 |
| `reunionDate` | `"YYYY-MM-DD"` | 下次见面日期，用于倒计时卡片 |
| `locations.panzi` / `locations.guozi` | `{ name, lat, lon, tz }` | 双方所在地点，驱动时钟、天气、时间表的时区换算 |
| `missLog` | `[{ who, time, label }]` | "我想你"按钮的点击记录，最多保留 50 条，新的在前面 |
| `answers` | `{ [date]: { panzi, guozi, panziSubmitted, guoziSubmitted } }` | 每日一问的回答，按日期存。**双方都提交后才互相可见**（模糊遮罩） |
| `customQuestions` | `[string]` | 双方自己添加的每日一问题库，会跟内置的 `builtinQuestions` 合并抽题，见 8.6 |
| `personalTodos` | `{ panzi: [{id,text,done}], guozi: [{id,text,done}] }` | 各自的自我监督代办清单，只有对应的人能改自己那份，对方只读，见 8.10 |
| `pushTokens` | `{ panzi: string\|null, guozi: string\|null }` | 各自设备注册到的 Web Push token，`sendPushToPartner()` 靠这个查"该发给谁"，见第 6.2 节 |
| `schedule` | `{ [date]: { china: {0..23: status}, london: {0..23: status} } }` | 每天 24 小时的忙闲状态表，`china`/`london` 这两个 key 名是历史遗留（即便地点改名了也不会变），分别对应 panzi 方 / guozi 方 |
| `scheduleTemplate` | `{ mon\|tue\|...\|sun: { china: {0..23}, london: {0..23} } }` | 每周固定作息模板，新的一天第一次被访问时会从这里按星期几克隆初始状态，见 8.7 |
| `playlist` | `[{ id, title, qq, apple, playing }]` | 一起听歌的歌单，`playing` 标记当前播放项（同一时间只有一条为 true） |
| `calls` | `[{ id, date, minutes }]` | 通话记录 |
| `todos` | `[{ id, text, cat, priority, done }]` | 共享待办，`cat` ∈ movies/books/places/other，`priority` ∈ low/medium/high |
| `thoughts` | `[{ id, who, mood, text, time }]` | 心情动态流，最多保留 80 条 |
| `updatedAt` | ISO 时间字符串 | 每次 `pushToCloud()` 时更新，目前只作记录用，没有被读取用于冲突判断 |
| `lastEvent` | `{ type, message, by, time }` | 见下方"跨端通知机制" |

新增字段时记得：
1. 在 `defaultState` 里给默认值（否则老用户/新设备第一次加载会是 `undefined`）。
2. `applyRemoteData()` 用的是 `{ ...defaultState, ...data }` 浅合并，**如果新字段是对象/数组，要在 `applyRemoteData()` 里额外处理深合并**（参考它对 `locations` 的特殊处理），否则远程数据里如果缺这个字段的子字段会导致 `undefined`。

---

## 5. 身份系统（谁是"我"）

`myIdentity`（`'panzi'` 或 `'guozi'`）**只存在 `localStorage`（key: `ldr_my_identity`），不会同步到云端**——这是故意的，因为这是"这台设备/这个人是谁"的本地设置，不是情侣共享数据。两人切换身份互不影响。

**身份现在是"选一次就锁死"的，网页端没有任何入口能再改**（这是产品需求，不是 bug）：

- `myIdentity` 初始值是 `localStorage.getItem('ldr_my_identity') || null`，注意默认值是 `null` 而不是某个具体身份——`null` 代表"这台设备还没选过"。
- `init()` 里如果发现 `myIdentity` 是 `null`，会把 `#identity-onboarding` 这个全屏遮罩显示出来，盖住整个页面，用户必须点其中一个按钮才能继续用网站。
- 遮罩上的按钮调用 `chooseIdentityOnce(who)`——这个函数第一行就是 `if (myIdentity) return;`，也就是说**只要 `myIdentity` 已经有值，之后再怎么调用这个函数都不会生效**。这是唯一能设置身份的函数，而且从设计上就不打算给它配一个"修改"按钮。
- 除了 onboarding 遮罩，**代码里再也没有第二处能触发身份切换的按钮**。以前的版本里，头部和"随机一问"卡片各有一组身份切换按钮，这是产品逻辑上的一个漏洞（选完身份后依然能到处改），现在两处都已经删除，`btn-identity-panzi` / `btn-identity-guozi` 这两个旧 id 也已经不存在了。
- `updateIdentityUI()`：只负责刷新跟身份相关的显示文字/颜色（头部身份 chip、"我想你"按钮文案），不改数据，跟以前一样。

**如果以后真的需要一个"重置身份"的功能**（比如两人的设备搞反了），目前唯一的办法是手动清掉这台设备 `localStorage` 里的 `ldr_my_identity` 这一项（浏览器开发者工具 → Application → Local Storage），网页本身故意没有暴露这个入口，这是需求方明确要的行为（"至少在网页端没有修改的机会"）。

**改代码时的坑**：很多地方用 `myIdentity === 'panzi' ? '小盘子' : '小果子'` 这种三元表达式硬编码中文名，没有做成统一的 `identityLabel(who)` 工具函数——如果以后要支持改名或者做成通用双人模板，这是最需要重构的地方（搜索 `'小盘子' : '小果子'` 能找到所有出现的地方）。

---

## 6. 跨端通知机制（两套并存：网页打开时 + 网页完全关闭时）

现在有**两套独立的通知路径**，分别覆盖不同场景，改代码时不要把两者搞混：

### 6.1 网页打开着（前台或后台常驻内存）——走 Firebase 实时监听

这是最早就有的机制，纯前端实现，不需要额外配置：

1. 任何一方做了操作（想你、回答问题、改时间表、发布心情、加待办……）都会调用 `emitEvent(type, message)`，写入 `state.lastEvent = { type, message, by, time }` 并整体存进 `state`（所以会随下一次 `saveState()` 一起同步上云）。
2. 对方设备收到 Firebase 推送的新数据后，`applyRemoteData()` 会调用 `handleRemoteEvent(event)`。
3. `handleRemoteEvent()` 用 `lastSeenEventTime`（存在 `localStorage`，key: `ldr_last_seen_event`）判断这条事件是不是"新的、而且不是自己发出的"，是的话才调用 `showLocalNotification()` 弹系统通知。
4. `showLocalNotification()` 优先通过 Service Worker 的 `postMessage` 让 `sw.js` 调 `registration.showNotification()`（这样锁屏/后台也能弹），SW 不可用时降级成页面内 `new Notification()`。

**这套机制的硬限制：必须有网页在跑（哪怕只是后台常驻内存）才会生效**——因为它依赖页面里正在执行的 JS 去监听数据库变化，网页完全关闭、系统把它从内存里清掉之后，没有任何代码在跑，自然收不到。

### 6.2 网页完全关闭也能收到——真正的 Web Push（新增）

这套机制解决 6.1 的硬限制，原理是操作系统级别的推送：即使网站完全没打开，系统也能在需要时短暂唤醒 Service Worker 去弹通知。要做到这一点，涉及三个必须分开的部分：

1. **注册**（`setupPushToken()`）：拿到通知权限后，用 Firebase Cloud Messaging 的 `getMessaging()` + `getToken()`（需要 `PUSH_CONFIG.vapidKey`）向浏览器申请一个"推送 token"，代表"这台设备、这个浏览器"。拿到 token 后存进 `state.pushTokens[myIdentity]`，同步到云端——这样对方那台设备才知道"该往哪个 token 发"。触发时机：`enableNotifications()` 授权成功后、`chooseIdentityOnce()` 选完身份后、`initFirebase()` 连上云端后，三处都会尝试调用一次（都是幂等的，没配置/没权限就直接跳过，不会报错）。
2. **发送**（`sendPushToPartner(title, body)`，在 `emitEvent()` 里被调用）：找到对方存的 token，直接 `fetch(PUSH_CONFIG.triggerUrl, ...)` 把"发给这个 token、标题是什么、内容是什么"发给自己部署的那个小型推送服务器。**这一步网页没法跳过服务器直接发**——因为真正调用 Google 的 FCM 发送接口，需要一个 OAuth 服务账号凭证，这个凭证只能放在受信任的服务器端，绝对不能出现在公开的前端代码里（否则任何人拿到都能冒充你发通知）。Google 在 2024 年也关掉了那种"前端直接拿一个 key 发"的旧版简化方案，现在没有绕过服务器的办法。
3. **接收**（`sw.js` 里的 `push` 事件监听器）：Web Push 到达时，操作系统会触发 Service Worker 的 `push` 事件（不是 `message` 事件，那是 6.1 用的），代码解析推送内容后调用 `self.registration.showNotification()` 弹出通知。这一段跟 6.1 的 `message` 事件监听器是两套独立的代码，处理的是两种不同来源的通知请求。

**push-worker.js**（部署到 Cloudflare Workers，不在 `index.html` 里）就是上面第 2 步"自己部署的推送服务器"，作用是安全保管 Google 服务账号凭证、代替网页调用 FCM 的 HTTP v1 发送接口（内部用 WebCrypto 手动签一个 JWT 换 access token，因为 Cloudflare Workers 环境不能直接用 Node 版的 Google 官方 SDK）。部署步骤见 README 末尾的"推送通知部署"章节。

**配置方式**：`index.html` 顶部的 `PUSH_CONFIG = { vapidKey, triggerUrl }`，跟 `FIREBASE_CONFIG` 是同样的"写死在代码里、部署一次、之后自动生效"模式。`isPushConfigured()` 检查这两个值是否都填了；只要缺一个，`setupPushToken()` 和 `sendPushToPartner()` 都会自动跳过，网站会自动退回到 6.1 那套"网页打开着才会通知"的模式，不会报错、不会影响其他功能。

**加新功能想要"对方会收到通知（包括网页完全关闭的情况）"，做法跟以前完全一样：只需要在该操作里加一行 `emitEvent('你的类型', '中文提示文案')`**——`emitEvent()` 内部已经同时处理了两套机制（写 `lastEvent` 给 6.1 用，调用 `sendPushToPartner()` 给 6.2 用），不需要新增功能的人再单独关心通知细节。

通知权限：不会自动弹窗请求，只有用户点顶部"开启通知"按钮（`enableNotifications()`）时才会 `requestNotifyPermission()`。

---

## 7. PWA / Service Worker（`sw.js`）

- `manifest.json`：定义了应用名（中文名/短名）、主题色（粉色系）、图标（用 data URI 内联的 SVG emoji 💕，没有用外部图片文件，好处是不用管图片路径，坏处是不能随便换图不改 manifest）。
- `sw.js` 现在有三个职责，互不依赖，改一个不影响另外两个：
  1. **离线缓存**：`install` 时缓存 `ASSETS`（首页壳、manifest、sw 自身）；`fetch` 时对页面导航请求用"网络优先，失败回退缓存"，对其他静态资源用"缓存优先"。缓存名 `ldr-hub-v2`——**如果以后要强制所有用户清掉旧缓存，改这个版本号字符串即可**（换名字会触发旧缓存被清理逻辑，见 `activate`，不过目前 `activate` 没写清理旧 cache 的代码，只调用了 `self.clients.claim()`，如果要做「淘汰旧版本缓存」需要在这里补一段遍历 `caches.keys()` 删掉非当前 `CACHE` 名的逻辑）。
  2. **网页打开时的通知**：监听页面发来的 `postMessage`（`type: 'SHOW_NOTIFICATION'`），调用 `showNotification()`；监听 `notificationclick` 让点击通知时聚焦/打开窗口。这是第 6.1 节那套机制用的。
  3. **网页完全关闭也能收到的推送（新增）**：监听浏览器/操作系统触发的 `push` 事件——这是标准 Web Push 协议的事件，跟上面第 2 点的 `message` 事件是完全不同的两个来源，不要搞混。收到后解析 `event.data`（JSON，包含 `title`/`body`，具体格式见 `push-worker.js` 里组装的 payload），同样调用 `showNotification()`。详见 README 第 6.2 节。

---

## 8. 功能逐个说明（UI 区块 ↔ 数据 ↔ 函数）

以下按页面从上到下的顺序列出每个功能模块，包含：这是什么、相关 DOM id、相关 JS 函数、用到哪个 `state` 字段。

### 8.1 顶部双城时钟
- **做什么**：实时显示双方本地时间、日期、白天/夜晚图标（☀️/🌙）。
- **函数**：`updateClocks()`，每秒调用一次（`setInterval`，见 `init()`）。
- **依赖**：`state.locations`（决定时区），用 `Intl`/`toLocaleTimeString` 做时区换算，没有引入第三方时区库。
- **相关 DOM**：`#china-time` `#china-date` `#china-icon` `#london-time` `#london-date` `#london-icon`，以及头部姓名旁的地点文字 `#header-panzi-loc` `#header-guozi-loc`（由 `updateLocationLabels()` 更新）。

### 8.2 双城天气卡片
- **做什么**：调 Open-Meteo API 拉当前温度和天气图标。
- **函数**：`fetchWeather()`，`init()` 里立即调一次 + 每 10 分钟刷新一次；地点被修改后也会立刻重新调用。
- **图标映射表**：`weatherCodes`（WMO 天气代码 → emoji + 中文描述），只覆盖了常见天气代码，遇到没列出的代码会显示 🌡️ 未知。
- **相关 DOM**：`#china-temp` `#china-desc` `#china-weather-icon`，`#london-*` 同理。
- **改地点入口**：`editLocation(who)`，用连续 `prompt()` 弹窗依次问地名/纬度/经度/时区（内置了一份常见中国城市→时区、常见欧美城市→时区的简单猜测规则，猜不中会用上一次的时区兜底），改完调用 `emitEvent()` 通知对方、`saveState()`、并联动刷新时钟/天气/时间表。

> 注意：地点编辑用的是浏览器原生 `prompt()`，没有做成表单弹窗——这是这个项目里**唯一大量使用 `prompt()`/`alert()` 做交互的地方**（还有 `editReunionDate()`、`editStartDates()`），如果以后要做成真正的 Modal，这几个函数是需要重写的目标。

### 8.3 "下次见面"倒计时
- **函数**：`updateCountdowns()`，每分钟刷新；`editReunionDate()` 改日期。
- **依赖**：`state.reunionDate`、`state.startTogether`、`state.startApart`。
- 到达/过了见面日期后文案会变成"终于见面了！🎉"（`diff <= 0` 分支）。

### 8.4 "在一起 N 天 / 异地 N 天"
- 同样在 `updateCountdowns()` 里计算，`editStartDates()` 改两个起始日期。

### 8.5 "我想你"按钮 + 想念记录
- **做什么**：点一下按钮，记一条"某人在某时刻想你了"，同时触发满屏爱心飘散动画，并推送通知给对方。
- **函数**：`triggerMissYou(who)` → 写 `state.missLog` → `emitEvent('miss', ...)` → `saveState()` → `updateMissYouUI()`（刷新今日次数和列表）+ `spawnHearts()`（纯视觉，创建临时 DOM 元素做 CSS 动画后自动移除，不存状态）。
- **相关 DOM**：`#miss-me-btn`（按钮文案/配色随身份变化，见 `updateIdentityUI()`）、`#miss-count`、`#miss-log`。

### 8.6 每日一问
- **做什么**：每天固定一道情侣问题（不是随机——用日期算出一个固定 index，所以同一天所有人看到的问题一样，且可预测/可复现）。
- **题库现在是"内置 + 自定义"两部分合并的，且会持续增长，不会有被问完的一天**：
  - `builtinQuestions` 数组：硬编码 120 道中文问题，想加题直接往数组里加字符串即可。
  - `state.customQuestions`：双方在"随机一问"卡片下方的 `<details>` 折叠面板里自己添加的问题（字符串数组，会同步到云端）。`addCustomQuestion()` 往里追加，`removeCustomQuestion(index)` 删除，`renderCustomQuestionList()` 负责渲染这个列表和计数。
  - `getQuestionPool()`：把 `builtinQuestions` 和 `state.customQuestions` 合并成完整题库池，`getDailyQuestion()` 每次都从这个池子里抽题，而不是只从写死的数组里抽——**以后想扩题库，最简单的方式就是让用户自己在面板里添加，不需要改代码重新部署**。
- **抽题算法**（`getDailyQuestion()`）：不是简单的 `dayIndex % pool.length`（那样题库一转完一轮马上从头重复，顺序还固定不变），而是用 `mulberry32()` 这个简单的可复现随机数生成器，把整个题库池按"第几轮"（`cycle = Math.floor(dayIndex / n)`）当种子做一次 Fisher-Yates 洗牌（`shuffledIndices()`），发完一整轮再重新洗下一轮。**这样能保证每道题都被问过一遍才会重复，且顺序每轮都不同**；因为种子只依赖 `cycle`（不依赖设备/时间戳的随机数），两台设备各自本地算出来的今日题目是一致的，不需要额外的网络请求去同步"今天该发哪题"。**改这块逻辑时要留意**：如果两人的 `state.customQuestions` 还没同步到一致（比如刚加了新问题、另一方还没收到），题库池大小 `n` 短暂不一致，算出来的题目可能对不上，等云端同步完成后会自动恢复一致，不需要特殊处理。
- **函数**：`getQuestionPool()`、`mulberry32()`、`shuffledIndices()`、`getDailyQuestion()`、`renderDailyQuestion()`、`submitMyAnswer()`、`addCustomQuestion()`、`removeCustomQuestion()`、`renderCustomQuestionList()`。
- **核心交互逻辑**：`state.answers[date]` 存双方回答，**只有 `panziSubmitted && guoziSubmitted` 都为 true 时才互相解锁看到对方答案**（`.blur-answer` CSS 类做模糊遮罩），这是这个功能最核心的产品逻辑，改的时候要保留这个"双方都提交才解锁"的行为。
- 代码里还留了一段兼容旧字段（`a.me`/`a.partner` → 迁移成 `a.panzi`/`a.guozi`）的逻辑，是历史数据结构变更留下的迁移代码，如果确认没有老数据了可以清理掉。
- **以前这里还有一组身份切换按钮（`btn-identity-panzi`/`btn-identity-guozi`），现在已经删掉**——身份现在统一由开屏的一次性选择决定，详见第 5 节。

### 8.7 时间表（Schedule）
- **做什么**：24 小时 × 双方，点击格子循环切换状态（空闲→工作→睡觉→可通话→空闲…），双方同一小时都选"可通话"时会自动合并高亮成"通话!"状态。
- **权限限制：每个人只能编辑自己那一栏**。`myScheduleColumn()` 把当前身份换算成对应的列 key（`panzi` → `'china'`，`guozi` → `'london'`——沿用了历史遗留的 key 命名，见下面的坑）。`renderSchedule()` 渲染格子时，只有 `myScheduleColumn()` 对应的那一栏会带 `onclick`/`schedule-slot` 交互样式，另一栏渲染成 `opacity-60 cursor-not-allowed` 且没有 `onclick`。`toggleSchedule(date, who, hour)` 内部第一行还加了一次防御性检查（`if (who !== myScheduleColumn()) return;`），即使有代码路径意外传入了对方的列也会被拦下，不是只靠"前端没渲染按钮"这种表面限制。**同样的限制也套用在下面的"每周模板"编辑器里**（`toggleTemplateSlot()` 有一样的守卫）。
- **函数**：`myScheduleColumn()`、`renderSchedule()`（渲染当天/翻页后的日期）、`getEffectiveScheduleStatus(date, who, hour)`（算某个格子实际该显示什么，见下）、`ensureScheduleDayShell(date)`（只保证容器结构存在，不预填 24 小时）、`toggleSchedule(date, who, hour)`（循环状态）、`changeScheduleDay(delta)`（左右翻页，`scheduleOffset` 控制，0=今天）。
- **技术难点**：小盘子和小果子在不同时区，页面上"小盘子本地 0-23 点"这一列，对应"小果子本地几点"每天会因为夏令时/时区不同而不同——`renderSchedule()` 里用了一个暴力搜索（遍历 48 个 UTC 小时点找到匹配的本地小时+日期）来做这个换算，没有依赖时区库。**这是全代码里最 tricky 的一段，改之前建议画个时间轴理清楚再动**。
- **数据存储上的坑**：`state.schedule[date].china[hour]` 和 `.london[hour]` 这两个 key 名字是历史遗留，即使把地点从"北京/伦敦"改成别的城市，数据结构里还是叫 `china`/`london`，不要因为改了地点名就去改这两个 key——`myScheduleColumn()` 的映射关系也依赖这两个固定 key，改的时候要一起改。

**每周固定模板**：以前每个新的一天都会套用同一份写死的默认作息，双方每次都要重新点一遍"可通话"之类的自定义状态。现在改成了"周模板"驱动：

- `state.scheduleTemplate`：`{ mon: {china:{0..23}, london:{0..23}}, tue: {...}, ..., sun: {...} }`，结构跟单日的 `state.schedule[date]`完全一样，只是按星期几分组而不是按具体日期分组。
- `buildDefaultDayTemplate()` / `buildDefaultTemplate()`：生成默认的单日/整周模板，`defaultState.scheduleTemplate` 直接用 `buildDefaultTemplate()` 初始化。
- `weekdayKeyOf(dateStr)`：把 `"2026-08-30"` 这样的日期字符串换算成 `'sun'..'sat'` 中的一个 key。**故意没有直接 `new Date(dateStr).getDay()`**，而是手动拆出年月日再用本地时区构造 `Date`，避免字符串被当成 UTC 解析后因为时区偏移错位到前一天/后一天。
- **格子的显示逻辑是"手动值优先，没有就实时读模板"（`getEffectiveScheduleStatus()`），不是"访问过就整天写死"**：
  - `getEffectiveScheduleStatus(date, who, hour)`：如果 `state.schedule[date][who][hour]` 有值（说明这个格子被手动改过），就用这个手动值；否则去 `state.scheduleTemplate[weekdayKeyOf(date)]` 里实时读对应星期的模板默认值。`renderSchedule()` 和模板编辑器里的 `renderTemplateEditor()` 都走这个函数取值。
  - `toggleSchedule(date, who, hour)` 点击时才通过 `ensureScheduleDayShell(date)` 建一个空壳（`{china:{},london:{}}`），把这一个格子的手动值写进去——**不会像以前那样一次性把这一整天 24 小时全部写死存起来**。
  - **这个设计是为了修复一个真实存在过的 bug**：早期版本里，`ensureSchedule(date)` 会在这一天第一次被打开（哪怕只是看一眼，包括页面刚加载时自动显示"今天"）的时候，就把当天 24 小时的值全部按模板"克隆"进 `state.schedule[date]`，之后这一整天就变成一份独立的"最终稿"。这导致改了"每周模板"之后，**几乎立刻就没用了**——因为"今天"这一天几乎总是已经被访问/克隆过，模板改动看不到任何效果，只有从来没打开过的遥远未来日期才会生效，用户几乎感知不到。现在改成"按格子懒加载"之后，只要某个具体的格子没有被手动点击改过，不管是今天、昨天还是任何日期，改模板都会立刻反映到该格子的显示上；只有真正被手动点击改过的那个格子，才会一直保留手动值、不再跟随模板变化。
- **模板编辑器 UI**：藏在 `#template-editor-overlay` 这个全屏弹层里，只有点时间表卡片头部的"📋 每周模板"按钮（`openScheduleTemplateEditor()`）才会打开，平时完全不可见，相当于一个独立的"设置页"。里面用 `#template-day-tabs`（周一到周日的切换标签，`switchTemplateDay()`）+ `#template-grid`（跟主时间表视觉一致的 24 小时格子，`renderTemplateEditor()` 渲染，`toggleTemplateSlot(day, who, hour)` 改状态，同样受 `myScheduleColumn()` 限制只能改自己那一栏）。**这个编辑器里的时间是"各自的本地时间"，不做跨时区换算**——跟主时间表视图里那套"小盘子本地时间行 ↔ 小果子本地时间行"的换算是两回事，改的时候不要搞混。
- `applyRemoteData()` 里对 `scheduleTemplate` 做了逐天补齐（跟 `locations` 的处理方式一样），防止老数据/远程数据缺某几天的模板导致访问 `undefined`。

### 8.8 一起听歌
- **做什么**：搜索一首歌，同时在 QQ音乐（小盘子）和 Apple Music（小果子）打开对应搜索页（不是真正的同步播放，只是同时跳转到两个音乐 App 的搜索结果页，让双方手动点开同一首歌"一起听"）；也可以维护一个共享歌单。
- **函数**：`searchAndOpenMusic()`（用 `window.open` 打开两个新标签页，注意第二个用了 `setTimeout(...,300)` 错开，是为了绕开浏览器"同一事件里多次 window.open 会被拦截弹窗"的限制）、`renderPlaylist()`、`setPlaying(id)`、`addTrack()`、`removeTrack(id)`。
- **相关 DOM**：`#music-search`、`#now-playing-title`、`#open-qq` / `#open-apple`（当前播放项的跳转链接，没有链接时隐藏）、`#playlist` 列表。
- 如果以后想接入网易云音乐等其他平台，在 `searchAndOpenMusic()` 里加一个新的 URL 模板 + 多开一个 `window.open` 即可，是这个功能里最容易水平扩展的部分。

### 8.9 电话记录
- **做什么**：记录每次通话的日期和时长，统计本月/总计时长、次数、平均时长，画一个近 7 天的柱状图。
- **通话计时器（新增）**：网页没有权限读取微信或系统的通话记录，做不到真正意义上的自动侦测，所以做了一个折中方案——手动计时器。`toggleCallTimer()` 控制开始/结束：点"开始"时把 `Date.now()` 存进 `localStorage`（key: `CALL_TIMER_KEY = 'ldr_call_timer_start'`，纯本机、不同步云端，只是为了避免刷新页面丢计时状态），点"结束"时用 `Date.now() - 开始时间` 算出分钟数（`Math.max(1, Math.round(...))`，保底 1 分钟），自动填进日期/小时/分钟输入框后直接调用 `addCall()` 记录，不用再手动点一次。`updateCallTimerDisplay()` 每秒刷新一次 `#call-timer-display` 的 mm:ss 显示。`resumeCallTimerIfRunning()` 在 `init()` 里调用，处理"计时中途刷新了页面"的情况——只要 `localStorage` 里还留着开始时间，就恢复计时器的运行状态和显示。
- **函数**：`toggleCallTimer()`、`updateCallTimerDisplay()`、`setCallTimerUIRunning(running)`、`resumeCallTimerIfRunning()`、`renderCalls()`（统计 + 画图 + 列表，都在一个函数里做完）、`addCall()`、`removeCall(id)`。
- **相关 DOM**：`#call-timer-btn` `#call-timer-display`、`#month-hours` `#total-hours` `#month-calls` `#avg-duration`、`#call-chart`（柱状图，纯 DOM+CSS 画的，没有用图表库）、`#call-list`。
- 柱状图的高度是 `Math.max(4, (mins/maxM)*100)`，最矮也留 4% 高度保证 0 分钟那天也有个可见的柱子底。
- **如果以后真的想做"自动"记录**：唯一现实的路径是脱离纯网页的范畴，比如做一个手机端的原生小组件/快捷指令去读系统通话记录再调用这里的数据接口写入，或者两人干脆约定"通话前后各点一下计时器"当成使用习惯——纯静态网页本身没有办法绕开浏览器沙盒去读取微信这类第三方 App 的数据。

### 8.10 共享待办 / 各自代办（互相监督）
- **共享待办**（`#todo-list` 所在的"共享待办"卡片）：情侣共同 to-do list，分类（电影/书籍/地点/其他）+ 优先级（高/中/低），可按分类筛选，双方都能添加/勾选/删除任何一项。**函数**：`renderTodos()`（排序规则：未完成排前面，同完成状态下按优先级 high→medium→low）、`filterTodo(cat)`、`addTodo()`、`toggleTodo(id)`、`removeTodo(id)`。分类图标写死在 `renderTodos()` 里的一个内联对象（`{ movies:'🎬', books:'📚', places:'📍', other:'✨' }`），加新分类要同时改：这里的图标映射、下拉框 `#new-todo-cat` 的 `<option>`、顶部筛选按钮栏。三处是分开维护的，没有做成统一配置数组，是以后重构的一个候选点。
- **各自代办（互相监督，新增）**：跟共享待办是完全独立的两套数据和 UI，`state.personalTodos = { panzi: [...], guozi: [...] }`。产品逻辑是"自己给自己列任务，只有自己能改，对方只能看"，用来互相监督进度。
  - `renderPersonalTodos()`：根据 `myIdentity` 决定哪一份是"我的"（可编辑）、哪一份是"对方的"（只读），动态刷新 `#personal-todo-my-label`/`#personal-todo-partner-label` 的文案，这个"我的/对方的"动态切换的写法跟"每日一问"里 `myKey`/`partnerKey` 的模式是一样的。
  - 对方的列表渲染成 `disabled` 的 checkbox、没有删除按钮、也没有绑定任何 `onclick`——纯只读展示。
  - `addPersonalTodo()` 永远只往 `state.personalTodos[myKey]` 里加。`togglePersonalTodo(id)` / `removePersonalTodo(id)` **只在 `myKey` 对应的数组里查找**，即使被意外传入属于对方的 id，因为在自己的数组里根本找不到这个 id，函数会直接返回、什么都不做——这是比"前端没渲染按钮"更进一步的防御，跟时间表的"改自己那栏"是同一个设计思路（防御性检查写在数据操作函数内部，不只是隐藏 UI）。
  - `applyRemoteData()` 里对 `personalTodos` 做了结构补齐（确保 `panzi`/`guozi` 两个 key 都存在且是数组），防止老数据/远程数据缺字段导致访问 `undefined`。

### 8.11 心情与想法
- **做什么**：类似一条只属于两人的私密动态流，选一个心情 + 写文字，按时间倒序展示。
- **函数**：`renderThoughts()`、`addThought()`、`toggleCustomMoodInput()`、`escapeHtml()`（渲染想法文字前手动转义，防止用户输入里的 `<script>` 之类内容变成真实 HTML）。**现在所有拼进 `innerHTML` 的自由文本字段都统一过了 `escapeHtml()`**：待办文字（`renderTodos` 里的 `t.text`）、各自代办文字（`renderPersonalTodos` 里的 `t.text`）、歌单标题（`renderPlaylist` 里的 `t.title`）、心情文字（`t.mood`）、通话日期（`c.date`）等，即使数据是绕过前端 UI、直接改 Firebase 数据库写进来的恶意内容，也不会被当成 HTML/脚本执行。**以后新增任何"拼进 `innerHTML` 的自由文本字段"，都要记得套一层 `escapeHtml()`，这是本项目唯一的安全底线，不要遗漏。**
- 歌单里的 QQ音乐/Apple Music 链接还额外套了 `safeUrl()`（同样在 `escapeHtml` 附近定义），只允许 `http://`/`https://` 开头的链接，防止有人在链接字段里塞 `javascript:` 伪协议——这类链接不经过 `innerHTML` 拼接也可能通过 `.href =` 直接赋值触发点击执行，所以两处（`renderPlaylist()` 里的列表项、以及顶部"当前播放"区域的 `#open-qq`/`#open-apple`）都要走 `safeUrl()`。
- **心情选项现在支持自定义**：`<select id="new-thought-mood">` 里除了 4 个预设选项，多了一个 `value="custom"` 的"✏️ 自定义..."选项。选中它会触发 `toggleCustomMoodInput()` 显示旁边的 `#new-thought-mood-custom` 文本框；`addThought()` 里如果 `select.value === 'custom'`，实际存的 `mood` 值改成从这个文本框读取（读不到内容会 `alert` 提示，不允许空心情）。想加固定的预设选项，直接在 `<select>` 里加 `<option>` 就行，不用改 JS；`custom` 这个 value 是保留字，不要拿去当某个预设心情的 value 用。

---

## 9. 渲染总入口

`renderAll()` 是所有"从 state 重新画一遍页面"的统一入口，`init()` 启动时调一次，`applyRemoteData()`（收到云端新数据时）也会调一次。**新增功能如果有自己的 render 函数，一定要记得加进 `renderAll()`，否则收到对方的云端更新后你这边不会刷新显示。**

`init()` 还负责：注册 Service Worker、启动时钟/天气/倒计时的定时器、绑定 `online`/`offline`/`visibilitychange` 全局事件、调用一次 `lucide.createIcons()` 渲染图标字体。

---

## 10. 已知的技术债 / 以后重构时可以考虑的点

- 云端写入是整个 `state` 对象整体覆盖，没有做字段级合并或冲突解决（小规模两人异步使用场景下够用）。
- 身份文案 `myIdentity === 'panzi' ? '小盘子' : '小果子'` 在多处硬编码，没抽成工具函数。
- 地点编辑（`editLocation`）、见面日期/起始日期编辑用的是原生 `prompt()`/`alert()`，交互比较简陋。
- 待办事项的"分类"配置（图标/下拉选项/筛选按钮）分散在三处维护。
- ~~`escapeHtml()` 只用在"心情与想法"模块~~ 已修复：所有拼进 `innerHTML` 的自由文本字段现在都统一走 `escapeHtml()`，歌单/通话链接额外走 `safeUrl()` 过滤非 http(s) 协议。
- `sw.js` 的 `activate` 事件目前不会清理旧版本缓存，只有换 `CACHE` 常量名才会让浏览器建新缓存，旧缓存不会被主动删除。
- 时间表的跨时区换算用暴力搜索 48 个 UTC 小时点实现，没有用标准时区库，逻辑集中在 `renderSchedule()` 里，改动前建议先理解清楚。

---

## 11. 如果要新增一个"双方共享、需要互相通知"的功能，建议的最小步骤

1. 在 `defaultState` 里加对应字段的默认值。
2. 如果新字段是对象/数组，检查 `applyRemoteData()` 的合并逻辑是否需要特殊处理（浅合并 `{...defaultState, ...data}` 对嵌套对象不够用时才需要）。
3. 写一个 `renderXxx()` 函数负责把这个字段画到页面上，并加进 `renderAll()`。
4. 写修改数据的函数（如 `addXxx()`），修改完调用顺序固定是：改 `state` → `emitEvent('类型', '中文提示')` → `saveState()` → `renderXxx()`。
5. 如果这个功能应该跨设备触发系统通知，第 4 步的 `emitEvent()` 就已经足够，不需要再碰通知相关代码。

---

## 12. 推送通知部署（网站完全关闭也能收到，一次性设置）

这一步是可选的——不做的话，通知功能会自动退回第 6.1 节那套"网页打开着才会收到"的模式，其他所有功能完全不受影响。做完之后就是永久生效，不需要重复配置。

1. **拿一个 VAPID 密钥对**：Firebase 控制台 → 项目设置（齿轮图标）→「Cloud Messaging」标签页 →「网页配置」区块下的「网页推送证书」→ 生成密钥对 → 复制那一长串字符。
2. **拿一个服务账号密钥**：Firebase 控制台 → 项目设置 →「服务账号」标签页 → 点「生成新的私钥」，会下载一个 JSON 文件。打开它，里面有 `client_email` 和 `private_key` 两个字段，等下要用。**这个文件不要提交到 GitHub 仓库**，只在下一步的 Cloudflare 后台里用一次。
3. **部署 `push-worker.js` 到 Cloudflare Workers**（免费）：
   - 注册/登录 [Cloudflare](https://dash.cloudflare.com/)，进入 Workers & Pages → 创建 Worker。
   - 把仓库里 `push-worker.js` 的内容整段粘贴进去，保存并部署。
   - 部署后会拿到一个形如 `https://你的worker名.你的账号.workers.dev` 的地址。
4. **给这个 Worker 配置三个 Secret**（Worker 的 Settings → Variables and Secrets，在网页上点点鼠标填，不要写进代码里）：
   - `FCM_PROJECT_ID`：Firebase 项目 ID（跟 `index.html` 里 `FIREBASE_CONFIG.projectId` 是同一个值）
   - `FCM_CLIENT_EMAIL`：第 2 步那个 JSON 文件里的 `client_email`
   - `FCM_PRIVATE_KEY`：第 2 步那个 JSON 文件里的 `private_key`（保留原始的换行，直接整段粘贴）
5. **回到 `index.html`**，找到 `PUSH_CONFIG`，把两个空字符串填上：
   ```js
   const PUSH_CONFIG = {
     vapidKey: "第 1 步复制的那一长串",
     triggerUrl: "第 3 步拿到的 Worker 地址"
   };
   ```
6. **提交、推送到 GitHub**，等 Pages 自动重新发布。
7. **两人都重新打开一次网站**，如果之前已经点过"开启通知"，建议重新点一次（`enableNotifications()` 里会顺带调用 `setupPushToken()` 去注册真正的推送 token）。两人的 token 都注册好、同步到云端之后，以后任何一方操作，另一方即使网站完全关闭也能收到系统通知。
8. **（可选，建议做）安全加固**：`push-worker.js` 顶部的 `ALLOWED_ORIGIN` 默认是 `'*'`（任何网站都能调用这个 Worker），部署好之后建议改成你们自己的 GitHub Pages 地址（比如 `'https://yourname.github.io'`），重新部署一次，这样只有你们自己的网站能触发它发送通知。

**为什么绕不开这一步**：真正调用 Google 的 FCM 发送接口，需要一个只能放在服务器端、绝不能公开的 OAuth 凭证（Google 在 2024 年已经关闭了那种"前端直接用一个 key 发"的旧版简化方案）。`push-worker.js` 就是那个"服务器端"，专门负责安全保管这个凭证、代替网页发送——网页本身自始至终都不会接触到这个凭证。
