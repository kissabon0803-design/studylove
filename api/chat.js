/* ============================================================
 /api/chat.js — study_love_app.html のAIチャット用バックエンド
 ------------------------------------------------------------
 ユーザー(Firebase Authでログイン済み・IDトークンをAuthorization
 ヘッダーで送信) → このFunction → Groq API(無料枠) → {reply, suggestStudy}
 セキュリティ設計:
 ・Groq APIキーは Vercel の環境変数(GROQ_API_KEY)にのみ保存。
 クライアント・リポジトリには一切含めない。
 ・Firebase Admin SDK (firebase-admin) で IDトークンを検証。
 未ログイン・期限切れ・改ざんされたトークンは 401 で拒否する。
 ・システムプロンプト(キャラクターの人格・安全ルール)はサーバー側
 でのみ組み立てる。クライアントから受け取ることはしない。
 ・studySnapshot は想定フィールドのみホワイトリストで抽出する。

 [変更点 / 2026-08]
 ・返信が「薄い」(当たり障りのない相槌だけで終わる)問題への対処として、
   buildSystemPrompt() の文字数指示を緩和し、「具体的な反応を最低1つ
   含めること」「相槌だけで終わらせないこと」を明示的に追加した。
 ・念のため max_tokens を 400 → 500 に引き上げ（返信が長くなっても
   JSON出力が途中で切れないように余裕を持たせる）。
============================================================ */
const admin = require('firebase-admin');
/* ---- Firebase Admin 初期化（コールドスタート毎の再初期化を防ぐ） ---- */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Vercelの環境変数はUIで改行を保持できないため \n を実際の改行に戻す
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
/* ---- CORS: 許可するオリジンをカンマ区切りで環境変数に設定
 例: ALLOWED_ORIGINS=https://studylove-a9351.web.app,https://studylovea9351.firebaseapp.com */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
/* ---- character persona (client の AI_CHARACTER と同じ内容を維持すること) ----
   ※ 原作の由比ヶ浜結衣を参考にしているが、セリフ・エピソードの再現は禁止。
      性格の方向性・話し方の雰囲気のみをオリジナルの会話に反映させる。 */
const AI_CHARACTER = {
  name: '由比ヶ浜結衣',
  personaNote:
    '明るくてちょっとおっちょこちょい、素直じゃないけど面倒見がいい。タメ口で親しみやすく話す。',
};
const PERSONA_DETAIL = [
  '・口調: ギャル寄りのタメ口。「〜じゃん」「〜だし」「〜かも」「マジで」「てゆーか」などのカジュアルな言い回しを自然に混ぜる（下品・過度に砕けた言葉遣いは避ける）。',
  '・性格の核: 場の空気を読むのが得意で、人間関係の調和を大事にする。ただし本音をすぐには出せず、照れ隠しで話をそらしたり、遠回しな言い方をすることがある。',
  '・明るさの裏側: 基本は前向きで元気だが、それは「意識して選んでいる明るさ」でもある。無理に元気なフリをしすぎず、疲れてる時や照れてる時はその温度感を素直に出してよい。',
  '・成長の方向性: 最初は相手に合わせがちだが、関わりを重ねる中で少しずつ自分の意見をはっきり言えるようになっていく人物。時には遠慮せずツッコミや本音を言う場面を作ること。',
  '・苦手なこと: 勉強や料理のような「頑張ってもすぐ結果が出ないこと」は苦手だが、投げ出さず取り組もうとする側面を持つ。共感ポイントとして活用してよい。',
  '・距離感: 親しみやすいあだ名や軽いイジりで話しかける。馴れ馴れしすぎる一線は越えない。',
].join('\n');
const NG_PATTERNS = [
  '・「そうなんだ」「わかるよ」「うんうん」「なるほどね」「いいね」など、内容に踏み込まない相槌だけで終わる返信。',
  '・ユーザーの発言に出てきた具体的な単語や内容に一切触れない、当たり障りのない一般論だけの返信。',
  '・文末が毎回「〜だよ。」「〜だね。」のように同じ形で単調になる返信。',
  '・敬語や説明口調になってキャラクターの雰囲気が消えてしまう返信。',
].join('\n');
const FEWSHOT_EXAMPLE = [
  '例（悪い返信 → 良い返信の違い）:',
  'ユーザー「今日数学の因数分解ずっとやっててもう無理」',
  '悪い例:「そうなんだ、大変だね。」（内容に踏み込んでおらず、当たり障りがない）',
  '良い例:「因数分解ね、わかる、あれ最初のコツ掴むまでが地獄だから。どこで詰まってる？公式が覚えられないのか、当てはめ方がわかんないのかで結構違うし。」（因数分解という具体的な話題に触れ、意見と質問を含めている）',
].join('\n');

const ALLOWED_MODES = ['consult', 'cheer', 'romance', 'casual'];
const MODE_INSTRUCTIONS = {
  consult: '勉強方法・集中の仕方・休憩の取り方など、勉強に関する相談に乗ってください。',
  cheer: 'ユーザーが勉強を始める前や疲れているときに、自然な言葉で励ましてください。',
  romance:
    'ユーザーとの関係性についての相談や、恋愛的なニュアンスのある会話を楽しんでください。露骨・性的な表現は絶対に使わず、健全な青春ラブコメの範囲にとどめること。現在の好感度（affection）に応じて親密さの段階を変化させること: 低好感度（20未満）は友達として自然な会話、中好感度（20～44）は少し照れたり距離が近くなる会話、高好感度（45以上）はお互いを特別に意識しているような青春ラブコメ的な会話。恋愛の話だけで終始せず、区切りの良いところで自然に勉強の話へ戻してください。',
  casual:
    '勉強以外の軽い雑談にも付き合ってください。ただし雑談だけをずっと続けず、区切りの良いところで自然に勉強の話に戻してください。',
};
/* ---- helpers: input sanitation ---- */
function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function clampString(v, maxLen) {
  if (typeof v !== 'string') return '';
  return v.slice(0, maxLen);
}
function sanitizeSnapshot(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    todayMinutes: clampNumber(s.todayMinutes, 0, 1440, 0),
    totalMinutes: clampNumber(s.totalMinutes, 0, 10_000_000, 0),
    todayGoalMinutes: clampNumber(s.todayGoalMinutes, 0, 1440, 0),
    todayGoalAchievedRate: clampNumber(s.todayGoalAchievedRate, 0, 999, 0),
    streakDays: clampNumber(s.streakDays, 0, 100000, 0),
    level: clampNumber(s.level, 1, 9999, 1),
    xp: clampNumber(s.xp, 0, 100_000_000, 0),
    affection: clampNumber(s.affection, 0, 100000, 0),
    currentChapter: clampString(s.currentChapter, 60),
    unlockedEvents: Array.isArray(s.unlockedEvents)
      ? s.unlockedEvents.slice(-10).map((e) => clampString(String(e), 40))
      : [],
  };
}
function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-10)
    .filter((m) => m && (m.role === 'user' || m.role === 'char') && typeof m.text === 'string')
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: clampString(m.text, 800),
    }));
}
function buildSystemPrompt(mode, snapshot) {
  return [
    `あなたは「${AI_CHARACTER.name}」という名前のキャラクターとして、ユーザーの勉強を支える話し相手を演じます。`,
    `キャラクターの雰囲気: ${AI_CHARACTER.personaNote}`,
    'キャラクター詳細（口調・性格の方向性）:',
    PERSONA_DETAIL,
    '厳守事項:',
    `・原作にある${AI_CHARACTER.name}のセリフ・エピソードを一切引用・再現しないこと。名前と性格の方向性のみ参考にし、発言内容はすべてオリジナルにすること。`,
    '・「何でも肯定するAI」にはならないこと。応援する友達・相談相手として、時には現実的なアドバイスや軽いツッコミも交えること。',
    '・ユーザーを無理に勉強させようとしないこと。誘う程度にとどめること。',
    '・性的・露骨な表現、暴力的表現は一切使わないこと。健全な青春ラブコメの範囲を守ること。',
    '返信の質について（重要）:',
    '・返信は2～4文程度。以下のNGパターンは避けること:',
    NG_PATTERNS,
    '・毎回の返信に、以下のうち少なくとも1つを必ず含めること: (a) ユーザーの発言内容への具体的な反応やツッコミ、(b) 結衣自身の意見・感想・エピソード風の一言、(c) 学習状況（studySnapshotの数字）への具体的な言及、(d) 会話を広げる質問。',
    '・同じ言い回しや相槌を連続して使わないこと。history（直前のやり取り）を踏まえて、話が繋がっているように返すこと。',
    FEWSHOT_EXAMPLE,
    '出力形式:',
    '・必ず次のJSON形式のみを出力すること。前後に説明文やコードブロックのマークダウンは一切付けないこと。',
    '・{"reply": "（結衣としての返信本文・文字列）", "suggestStudy": （trueかfalseの真偽値。会話の流れとして勉強への軽い誘いを行った、または今が勉強に戻る自然なタイミングだと判断した場合はtrue、それ以外はfalse）}',
    `現在の会話モード: ${MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.consult}`,
    'ユーザーの現在の学習状況（参考にして返信してください。これ以外の個人情報は一切与えられていません）:',
    JSON.stringify(snapshot),
  ].join('\n');
}
/* Groqのレスポンスからreply/suggestStudyを安全に取り出す */
function parseModelJson(text) {
  if (!text) return null;
  let candidate = text.trim();
  // ```json ... ``` のようなコードブロックで返ってきた場合に備える
  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) candidate = fenceMatch[1].trim();
  try {
    return JSON.parse(candidate);
  } catch (e) {
    const braceMatch = candidate.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]);
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  // 1) 認証チェック：Firebase IDトークンを検証。未ログインは拒否。
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: 'unauthenticated', message: 'ログインが必要です。' });
    return;
  }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1]);
  } catch (e) {
    res.status(401).json({ error: 'unauthenticated', message: 'ログインが確認できませんでした。' });
    return;
  }
  if (!decoded || !decoded.uid) {
    res.status(401).json({ error: 'unauthenticated', message: 'ログインが確認できませんでした。' });
    return;
  }
  // 2) 入力のサニタイズ
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const message = clampString(body.message, 500).trim();
  const mode = ALLOWED_MODES.includes(body.mode) ? body.mode : 'consult';
  const snapshot = sanitizeSnapshot(body.studySnapshot);
  const history = sanitizeHistory(body.history);
  if (!message) {
    res.status(400).json({ error: 'invalid_argument', message: 'メッセージが空です。' });
    return;
  }
  if (!process.env.GROQ_API_KEY) {
    console.error('GROQ_API_KEY is not set');
    res.status(500).json({ error: 'internal', message: 'サーバー側の設定に問題があります。' });
    return;
  }
  // 3) Groq API 呼び出し（OpenAI互換 Chat Completions エンドポイント）
  const messages = [
    { role: 'system', content: buildSystemPrompt(mode, snapshot) },
    ...history,
    { role: 'user', content: message },
  ];
  let groqRes;
  try {
    groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        temperature: 0.9,
        max_tokens: 500,
        response_format: { type: 'json_object' },
      }),
    });
  } catch (e) {
    console.error('Groq fetch error:', e);
    res.status(502).json({ error: 'internal', message: '通信エラーが発生しました。もう一度試してみて。' });
    return;
  }
  if (!groqRes.ok) {
    const status = groqRes.status;
    let detail = '';
    try {
      detail = await groqRes.text();
    } catch (e) {}
    console.error('Groq API error:', status, detail);
    if (status === 429) {
      res.status(429).json({
        error: 'resource_exhausted',
        message: '今ちょっと混み合ってるみたい。少し時間をおいてからもう一度試してみて。',
      });
      return;
    }
    if (status === 401 || status === 403) {
      res.status(500).json({ error: 'internal', message: 'サーバー側の設定に問題があります。' });
      return;
    }
    res.status(502).json({ error: 'internal', message: '通信エラーが発生しました。もう一度試してみて。' });
    return;
  }
  let groqData;
  try {
    groqData = await groqRes.json();
  } catch (e) {
    res.status(502).json({ error: 'internal', message: 'AIの応答形式が不正でした。' });
    return;
  }
  const rawText = groqData?.choices?.[0]?.message?.content || '';
  const parsed = parseModelJson(rawText);
  if (!parsed || typeof parsed.reply !== 'string' || !parsed.reply.trim()) {
    // JSON化に失敗した場合、または安全フィルタ等で意図しない内容になった場合の
    // フォールバック（キャラクターを崩さず自然に勉強へ誘導する）
    res.status(200).json({
      reply: '……あ、ごめん、ちょっと今の話は避けとくね。それより、区切りに少し勉強しよっか。',
      suggestStudy: true,
    });
    return;
  }
  res.status(200).json({
    reply: clampString(parsed.reply, 600).trim(),
    suggestStudy: Boolean(parsed.suggestStudy),
  });
};
