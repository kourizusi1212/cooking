# ワイワイキッチン

最大5人で協力してハンバーガーとサラダを作る、ブラウザで遊ぶ3D料理ゲームです。

## ローカルで遊ぶ

1. Node.js 18 以上をインストール
2. `npm start`(または `node server.js`)
3. ブラウザで `http://localhost:3000` を開く
4. 同じ Wi-Fi の友達には、起動時に表示される `http://192.168.x.x:3000` を伝える
5. 同じルーム名で入室 → 誰かが「ゲームスタート」

追加パッケージは不要です。three.js は CDN から読み込みます。

## GitHub + Render で公開する

### 1. GitHub に置く
```bash
cd wai-wai-kitchen
git init
git add .
git commit -m "ワイワイキッチン"
git branch -M main
git remote add origin https://github.com/<あなたのユーザー名>/wai-wai-kitchen.git
git push -u origin main
```
(先に GitHub で空のリポジトリ `wai-wai-kitchen` を作っておく)

### 2. Render にデプロイ
**方法A: Blueprint(おすすめ)**
1. [Render](https://render.com) にログイン → **New > Blueprint**
2. GitHub のリポジトリを選ぶ(`render.yaml` が自動で読み込まれます)
3. **Apply** を押す。数分で `https://wai-wai-kitchen-xxxx.onrender.com` が発行されます

**方法B: 手動**
1. **New > Web Service** → リポジトリを選ぶ
2. Runtime: `Node` / Build Command: `npm install` / Start Command: `npm start`
3. Health Check Path: `/healthz`
4. Instance Type: Free で OK

### 3. 遊ぶ
発行された URL を友達に送り、同じルーム名で入室します。HTTPS 上では自動で `wss://` 接続になります。

### Render 無料プランの注意
- 約15分アクセスがないとスリープし、次のアクセスで起動に30秒〜1分かかります。遊ぶ前に URL を一度開いておくと安心です。
- ゲーム状態はサーバーのメモリ上にあります。再起動やスリープで部屋は消えます(データ保存はありません)。
- 最大5人の同時プレイなら無料プランで動きます。

## 操作

| 操作 | キー |
|---|---|
| 移動 / 走る | WASD / Shift |
| 視点 | マウス(画面クリックで操作開始、Escで解放) |
| 取る・置く・皿に乗せる・提供 | E または 左クリック |
| 野菜を切る | F または 右クリック(4回) |

## ルール

- 注文伝票(画面上部)の通りに料理を作り、手前の「提供口」へ。
- パティ: 生パティ → グリルで約8秒で焼き上がり(バーが緑)。約18秒で焦げる。
- レタス・トマト: まな板に置いて F で刻む。
- お皿にバンズ・焼きパティ・刻み野菜を乗せる(順番は自由)。
- 提供で得点、時間切れの注文は減点。制限時間は5分。

## ファイル

- `server.js` … HTTP + WebSocket サーバーとゲームロジック(依存なし)
- `index.html` … 3D クライアント(three.js)
- `render.yaml` … Render 用の設定(Blueprint)
- `package.json` / `.gitignore` … Node.js / Git 用
