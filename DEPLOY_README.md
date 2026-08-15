# study_love_app – Groq連携（Vercel + Firebase Auth） デプロイ手順

## 構成
```
ユーザー → study_love_app.html (Firebase Auth でログイン済み・IDトークン取得)
        → fetch(Authorization: Bearer <IDトークン>)
        → Vercel Serverless Function  /api/chat  (Node.js)
             - firebase-admin で IDトークンを検証（未ログインは401で拒否）
             - Groq Chat Completions API を呼び出す（APIキーはサーバー側の環境変数のみ）
        → Groq API（無料枠, llama-3.3-70b-versatile）
        → { reply, suggestStudy } を返却 → チャット画面に表示
```

Firebase Functions は使用しません。Blazeプラン（従量課金）へのアップグレードは不要です。
Groq APIキーはクライアントに一切保存されません。

## 0. 前提
- Node.js 20系
- Vercelアカウント（クレジットカード不要のHobbyプランで可）
- 既存のFirebaseプロジェクト `studylove-a9351`（Firebase Authenticationはそのまま利用）

## 1. Groq APIキーの取得
1. https://console.groq.com にアクセスし、Googleアカウント等でログイン（クレジットカード不要）
2. 「API Keys」からキーを発行（`gsk_...` の形式）

無料枠の目安（2026年時点、変動あり）: `llama-3.3-70b-versatile` で
30 requests/min、1,000 requests/day 程度。個人開発の利用規模であれば十分です。

## 2. Firebase サービスアカウントの発行
Firebase Admin SDKでIDトークンを検証するために必要です。

1. Firebaseコンソール → プロジェクトの設定 → サービスアカウント
2. 「新しい秘密鍵の生成」でJSONファイルをダウンロード
3. JSON内の以下3つの値を後述の環境変数に使用します:
   - `project_id`
   - `client_email`
   - `private_key`

⚠️ このJSONファイルは絶対にクライアント側や公開リポジトリに含めないでください。

## 3. Vercelプロジェクトの作成
```bash
npm install -g vercel
cd vercel-backend
vercel login
vercel link   # 新規プロジェクトとして作成、または既存に紐付け
```

## 4. 環境変数の設定
Vercelダッシュボード → Project → Settings → Environment Variables で、
`.env.example` を参考に以下を登録します（Production / Preview 両方）:

| Key | 説明 |
|---|---|
| `GROQ_API_KEY` | 手順1で発行したキー |
| `GROQ_MODEL` | 任意。デフォルトは `llama-3.3-70b-versatile` |
| `FIREBASE_PROJECT_ID` | `studylove-a9351` |
| `FIREBASE_CLIENT_EMAIL` | サービスアカウントJSONの `client_email` |
| `FIREBASE_PRIVATE_KEY` | サービスアカウントJSONの `private_key`（改行は `\n` のまま1行で貼り付けてOK。コード側で復元します） |
| `ALLOWED_ORIGINS` | `study_love_app.html` を配信しているオリジン（カンマ区切り、例: `https://studylove-a9351.web.app`） |

CLIから設定する場合:
```bash
vercel env add GROQ_API_KEY
vercel env add GROQ_MODEL
vercel env add FIREBASE_PROJECT_ID
vercel env add FIREBASE_CLIENT_EMAIL
vercel env add FIREBASE_PRIVATE_KEY
vercel env add ALLOWED_ORIGINS
```

## 5. デプロイ
```bash
vercel --prod
```
デプロイ完了後に発行されるURL（例: `https://study-love-chat.vercel.app`）を控えてください。

## 6. クライアント側の設定
`study_love_app.html` 内の以下の定数を、実際のVercel URLに書き換えます:
```js
const CHAT_API_URL = 'https://YOUR-VERCEL-PROJECT.vercel.app/api/chat';
```
（該当箇所には `⚠️ API接続ポイント` とコメントがあります）

## 7. 動作確認
- ログインした状態で4モード（勉強相談・応援・雑談・恋愛）それぞれ送信し、返信が来ることを確認
- ログアウト状態、または`Authorization`ヘッダーなしで `/api/chat` を直接叩いた場合に
  `401` が返ることを確認（ブラウザのDevToolsやcurlで確認可）
- 想定していないオリジンからのアクセスがCORSでブロックされることを確認

## トラブルシューティング
- `401 unauthenticated` が常に返る → `FIREBASE_PRIVATE_KEY` の改行変換ミスの可能性が高いです。
  値の中の `\n` がそのまま文字列として渡っているか確認してください（コード側で `\n` → 実改行に変換しています）。
- CORSエラーでブラウザからのリクエストが失敗する → `ALLOWED_ORIGINS` に実際のオリジンが
  含まれているか確認してください（末尾スラッシュなし、`https://`込みで完全一致が必要です）。
- `429 resource_exhausted`（画面上は「混み合ってるみたい」というメッセージ） →
  Groq無料枠のレート制限に達しています。時間を置くか、Groqコンソールで利用状況を確認してください。
- Groqのモデル名が変更・非推奨になった場合は、Vercelの環境変数 `GROQ_MODEL` を
  変更するだけでコードの修正なしに切り替えられます（最新のモデル一覧は
  https://console.groq.com/docs/models で確認してください）。
