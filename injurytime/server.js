const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const Database = require("better-sqlite3");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const allowedCompetitions = ["PL", "PD", "BL1", "SA", "FL1"];

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "app.db");
const UPLOAD_DIR = path.join(__dirname, "public", "uploads");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("이미지 파일만 업로드할 수 있습니다."));
    }

    cb(null, true);
  }
});

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function ensureColumn(tableName, columnName, columnDefinition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some(column => column.name === columnName);

  if (!exists) {
    db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`).run();
  }
}

db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,
    age INTEGER NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 10000,
    created_at TEXT NOT NULL
  )
`).run();

ensureColumn("users", "points", "INTEGER NOT NULL DEFAULT 10000");

db.prepare(`
  UPDATE users
  SET points = 10000
  WHERE points IS NULL
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS follows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    item_type TEXT NOT NULL CHECK(item_type IN ('team', 'player')),
    item_id TEXT NOT NULL,
    item_name TEXT NOT NULL,
    item_meta TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, item_type, item_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS weekly_likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    item_type TEXT NOT NULL CHECK(item_type IN ('team', 'player', 'match')),
    item_id TEXT NOT NULL,
    item_name TEXT NOT NULL,
    item_meta TEXT,
    week_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, item_type, item_id, week_key),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS match_predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    match_id TEXT NOT NULL,
    prediction_result TEXT NOT NULL CHECK(prediction_result IN ('home', 'draw', 'away')),
    home_score INTEGER NOT NULL,
    away_score INTEGER NOT NULL,
    match_meta TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, match_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    item_type TEXT NOT NULL CHECK(item_type IN ('team', 'player', 'match')),
    item_id TEXT NOT NULL,
    item_name TEXT NOT NULL,
    item_meta TEXT,
    parent_comment_id INTEGER,
    body TEXT NOT NULL,
    week_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(parent_comment_id) REFERENCES comments(id) ON DELETE CASCADE
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS comment_likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    comment_id INTEGER NOT NULL,
    week_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, comment_id, week_key),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(comment_id) REFERENCES comments(id) ON DELETE CASCADE
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS board_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    image_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS board_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    parent_comment_id INTEGER,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(post_id) REFERENCES board_posts(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(parent_comment_id) REFERENCES board_comments(id) ON DELETE CASCADE
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS board_post_likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    week_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(post_id, user_id, week_key),
    FOREIGN KEY(post_id) REFERENCES board_posts(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS board_comment_likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    week_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(comment_id, user_id, week_key),
    FOREIGN KEY(comment_id) REFERENCES board_comments(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    match_id TEXT NOT NULL,
    selection TEXT NOT NULL CHECK(selection IN ('home', 'draw', 'away')),
    stake INTEGER NOT NULL,
    odds REAL NOT NULL,
    potential_payout INTEGER NOT NULL,
    actual_payout INTEGER,
    status TEXT NOT NULL CHECK(status IN ('pending', 'won', 'lost', 'void')),
    match_meta TEXT,
    created_at TEXT NOT NULL,
    settled_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`).run();

ensureColumn("bets", "actual_payout", "INTEGER");

function formatDate(date) {
  return date.toISOString().split("T")[0];
}

function getKoreaIsoWeekKey(date = new Date()) {
  const KST_OFFSET = 9 * 60 * 60 * 1000;
  const kstDate = new Date(date.getTime() + KST_OFFSET);

  const d = new Date(Date.UTC(
    kstDate.getUTCFullYear(),
    kstDate.getUTCMonth(),
    kstDate.getUTCDate()
  ));

  const day = d.getUTCDay() || 7;

  d.setUTCDate(d.getUTCDate() + 4 - day);

  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);

  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function safeJsonParse(value, fallback = {}) {
  if (!value) return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitizeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    nickname: user.nickname,
    age: user.age,
    email: user.email,
    points: user.points,
    createdAt: user.created_at
  };
}

function createToken(user) {
  if (!JWT_SECRET) {
    throw new Error(".env 파일에 JWT_SECRET이 없습니다.");
  }

  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      nickname: user.nickname
    },
    JWT_SECRET,
    {
      expiresIn: JWT_EXPIRES_IN
    }
  );
}

function setAuthCookie(res, token) {
  res.cookie("auth_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function clearAuthCookie(res) {
  res.clearCookie("auth_token", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production"
  });
}

function requireAuth(req, res, next) {
  try {
    const token = req.cookies.auth_token;

    if (!token) {
      return res.status(401).json({
        error: "로그인이 필요합니다."
      });
    }

    if (!JWT_SECRET) {
      return res.status(500).json({
        error: ".env 파일에 JWT_SECRET이 없습니다."
      });
    }

    const payload = jwt.verify(token, JWT_SECRET);

    const user = db
      .prepare("SELECT id, nickname, age, email, points, created_at FROM users WHERE id = ?")
      .get(payload.id);

    if (!user) {
      clearAuthCookie(res);

      return res.status(401).json({
        error: "유효하지 않은 사용자입니다."
      });
    }

    req.user = user;
    next();
  } catch {
    clearAuthCookie(res);

    return res.status(401).json({
      error: "로그인이 만료되었거나 유효하지 않습니다."
    });
  }
}

function checkCompetition(competition, res) {
  if (!allowedCompetitions.includes(competition)) {
    res.status(400).json({
      error: "지원하지 않는 리그 코드입니다."
    });
    return true;
  }

  if (!API_KEY) {
    res.status(500).json({
      error: ".env 파일에 FOOTBALL_DATA_API_KEY가 없습니다."
    });
    return true;
  }

  return false;
}

function checkApiKey(res) {
  if (!API_KEY) {
    res.status(500).json({
      error: ".env 파일에 FOOTBALL_DATA_API_KEY가 없습니다."
    });
    return true;
  }

  return false;
}

async function footballDataRequest(url) {
  const response = await fetch(url, {
    headers: {
      "X-Auth-Token": API_KEY
    }
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    const error = new Error("football-data API 응답이 JSON 형식이 아닙니다.");
    error.status = response.status;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(data.message || data.error || "football-data API 요청 실패");
    error.status = response.status;
    throw error;
  }

  return data;
}

async function getMatchFromApi(matchId) {
  if (!API_KEY) return null;

  try {
    return await footballDataRequest(`https://api.football-data.org/v4/matches/${matchId}`);
  } catch {
    return null;
  }
}

function normalizeMatchMetaFromApi(match) {
  if (!match) return null;

  return {
    utcDate: match.utcDate,
    status: match.status,
    competition: match.competition?.name,
    homeTeam: match.homeTeam?.name,
    awayTeam: match.awayTeam?.name,
    homeCrest: match.homeTeam?.crest,
    awayCrest: match.awayTeam?.crest
  };
}

function getMatchResultFromScore(homeScore, awayScore) {
  if (homeScore > awayScore) return "home";
  if (homeScore < awayScore) return "away";
  return "draw";
}

function getBetPools(matchId, extraSelection = null, extraStake = 0) {
  const rows = db.prepare(`
    SELECT selection, SUM(stake) AS total
    FROM bets
    WHERE match_id = ?
      AND status = 'pending'
    GROUP BY selection
  `).all(String(matchId));

  const pools = {
    home: 0,
    draw: 0,
    away: 0
  };

  rows.forEach(row => {
    pools[row.selection] = row.total || 0;
  });

  if (extraSelection && ["home", "draw", "away"].includes(extraSelection)) {
    pools[extraSelection] += Number(extraStake || 0);
  }

  const totalPool = pools.home + pools.draw + pools.away;

  function calcOdds(selection) {
    if (pools[selection] <= 0 || totalPool <= 0) return null;
    return Number((totalPool / pools[selection]).toFixed(2));
  }

  return {
    totalPool,
    pools,
    odds: {
      home: calcOdds("home"),
      draw: calcOdds("draw"),
      away: calcOdds("away")
    }
  };
}

function calcParimutuelPayout(stake, winningPool, totalPool) {
  if (winningPool <= 0 || totalPool <= 0) return 0;
  return Math.floor((stake / winningPool) * totalPool);
}

function likeInfo(userId, itemType, itemId) {
  const weekKey = getKoreaIsoWeekKey();

  const count = db.prepare(`
    SELECT COUNT(*) AS count
    FROM weekly_likes
    WHERE item_type = ? AND item_id = ? AND week_key = ?
  `).get(itemType, String(itemId), weekKey).count;

  const mine = db.prepare(`
    SELECT id
    FROM weekly_likes
    WHERE user_id = ? AND item_type = ? AND item_id = ? AND week_key = ?
  `).get(userId, itemType, String(itemId), weekKey);

  return {
    weekKey,
    count,
    liked: Boolean(mine)
  };
}

function commentLikeInfo(userId, commentId) {
  const weekKey = getKoreaIsoWeekKey();

  const count = db.prepare(`
    SELECT COUNT(*) AS count
    FROM comment_likes
    WHERE comment_id = ? AND week_key = ?
  `).get(Number(commentId), weekKey).count;

  const mine = db.prepare(`
    SELECT id
    FROM comment_likes
    WHERE user_id = ? AND comment_id = ? AND week_key = ?
  `).get(userId, Number(commentId), weekKey);

  return {
    weekKey,
    count,
    liked: Boolean(mine)
  };
}

function getCommentsForItem(userId, itemType, itemId) {
  const weekKey = getKoreaIsoWeekKey();

  const rows = db.prepare(`
    SELECT
      c.id,
      c.user_id,
      c.item_type,
      c.item_id,
      c.item_name,
      c.item_meta,
      c.parent_comment_id,
      c.body,
      c.week_key,
      c.created_at,
      u.nickname
    FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.item_type = ?
      AND c.item_id = ?
      AND c.week_key = ?
    ORDER BY c.created_at ASC
  `).all(itemType, String(itemId), weekKey);

  return rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    nickname: row.nickname,
    itemType: row.item_type,
    itemId: row.item_id,
    itemName: row.item_name,
    itemMeta: safeJsonParse(row.item_meta),
    parentCommentId: row.parent_comment_id,
    body: row.body,
    weekKey: row.week_key,
    createdAt: row.created_at,
    like: commentLikeInfo(userId, row.id)
  }));
}

function validatePredictionAndScore(predictionResult, homeScore, awayScore) {
  if (predictionResult === "home" && homeScore <= awayScore) {
    return "홈 승 예측이면 홈 스코어가 원정 스코어보다 커야 합니다.";
  }

  if (predictionResult === "away" && awayScore <= homeScore) {
    return "원정 승 예측이면 원정 스코어가 홈 스코어보다 커야 합니다.";
  }

  if (predictionResult === "draw" && homeScore !== awayScore) {
    return "무승부 예측이면 홈 스코어와 원정 스코어가 같아야 합니다.";
  }

  return null;
}

function boardPostLikeInfo(userId, postId) {
  const weekKey = getKoreaIsoWeekKey();

  const count = db.prepare(`
    SELECT COUNT(*) AS count
    FROM board_post_likes
    WHERE post_id = ? AND week_key = ?
  `).get(Number(postId), weekKey).count;

  const mine = db.prepare(`
    SELECT id
    FROM board_post_likes
    WHERE post_id = ? AND user_id = ? AND week_key = ?
  `).get(Number(postId), userId, weekKey);

  return {
    weekKey,
    count,
    liked: Boolean(mine)
  };
}

function boardCommentLikeInfo(userId, commentId) {
  const weekKey = getKoreaIsoWeekKey();

  const count = db.prepare(`
    SELECT COUNT(*) AS count
    FROM board_comment_likes
    WHERE comment_id = ? AND week_key = ?
  `).get(Number(commentId), weekKey).count;

  const mine = db.prepare(`
    SELECT id
    FROM board_comment_likes
    WHERE comment_id = ? AND user_id = ? AND week_key = ?
  `).get(Number(commentId), userId, weekKey);

  return {
    weekKey,
    count,
    liked: Boolean(mine)
  };
}

function getBoardComments(userId, postId) {
  const rows = db.prepare(`
    SELECT
      c.id,
      c.post_id,
      c.user_id,
      c.parent_comment_id,
      c.body,
      c.created_at,
      u.nickname
    FROM board_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.post_id = ?
    ORDER BY c.created_at ASC
  `).all(Number(postId));

  return rows.map(row => ({
    id: row.id,
    postId: row.post_id,
    userId: row.user_id,
    parentCommentId: row.parent_comment_id,
    body: row.body,
    createdAt: row.created_at,
    nickname: row.nickname,
    like: boardCommentLikeInfo(userId, row.id)
  }));
}

/* =========================
   Auth API
========================= */

app.post("/api/signup", async (req, res) => {
  try {
    const { nickname, age, email, password } = req.body;

    if (!nickname || !age || !email || !password) {
      return res.status(400).json({
        error: "닉네임, 나이, 이메일, 비밀번호를 모두 입력해야 합니다."
      });
    }

    const trimmedNickname = String(nickname).trim();
    const parsedAge = Number(age);
    const normalizedEmail = String(email).trim().toLowerCase();
    const plainPassword = String(password);

    if (trimmedNickname.length < 2) {
      return res.status(400).json({
        error: "닉네임은 2글자 이상이어야 합니다."
      });
    }

    if (!Number.isInteger(parsedAge) || parsedAge < 1 || parsedAge > 120) {
      return res.status(400).json({
        error: "나이는 1부터 120 사이의 숫자여야 합니다."
      });
    }

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({
        error: "올바른 이메일 형식이 아닙니다."
      });
    }

    if (plainPassword.length < 8) {
      return res.status(400).json({
        error: "비밀번호는 8자 이상이어야 합니다."
      });
    }

    const exists = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(normalizedEmail);

    if (exists) {
      return res.status(409).json({
        error: "이미 가입된 이메일입니다."
      });
    }

    const passwordHash = await bcrypt.hash(plainPassword, 12);

    const result = db.prepare(`
      INSERT INTO users (nickname, age, email, password_hash, points, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      trimmedNickname,
      parsedAge,
      normalizedEmail,
      passwordHash,
      10000,
      new Date().toISOString()
    );

    const user = db
      .prepare("SELECT id, nickname, age, email, points, created_at FROM users WHERE id = ?")
      .get(result.lastInsertRowid);

    const token = createToken(user);
    setAuthCookie(res, token);

    res.status(201).json({
      message: "회원가입이 완료되었습니다. 10000 포인트가 지급되었습니다.",
      user: sanitizeUser(user)
    });
  } catch (error) {
    res.status(500).json({
      error: "회원가입 처리 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "이메일과 비밀번호를 모두 입력해야 합니다."
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const user = db
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(normalizedEmail);

    if (!user) {
      return res.status(401).json({
        error: "이메일 또는 비밀번호가 올바르지 않습니다."
      });
    }

    const ok = await bcrypt.compare(String(password), user.password_hash);

    if (!ok) {
      return res.status(401).json({
        error: "이메일 또는 비밀번호가 올바르지 않습니다."
      });
    }

    const token = createToken(user);
    setAuthCookie(res, token);

    res.json({
      message: "로그인 성공",
      user: sanitizeUser(user)
    });
  } catch (error) {
    res.status(500).json({
      error: "로그인 처리 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({
    user: sanitizeUser(req.user)
  });
});

app.post("/api/logout", (req, res) => {
  clearAuthCookie(res);

  res.json({
    message: "로그아웃되었습니다."
  });
});

/* =========================
   Ranking / Point API
========================= */

app.get("/api/ranking", requireAuth, (req, res) => {
  try {
    const ranking = db.prepare(`
      SELECT id, nickname, points
      FROM users
      ORDER BY points DESC, id ASC
      LIMIT 10
    `).all();

    res.json({
      ranking
    });
  } catch (error) {
    res.status(500).json({
      error: "랭킹을 불러오지 못했습니다.",
      detail: error.message
    });
  }
});

/* =========================
   Betting API - Parimutuel Pool
========================= */

app.get("/api/odds/:matchId", requireAuth, async (req, res) => {
  try {
    const matchId = String(req.params.matchId);

    const selection = req.query.selection || null;
    const stake = Number(req.query.stake || 0);

    const apiMatch = await getMatchFromApi(matchId);
    const apiMeta = normalizeMatchMetaFromApi(apiMatch);

    const queryMeta = {
      homeTeam: req.query.homeTeam || undefined,
      awayTeam: req.query.awayTeam || undefined,
      utcDate: req.query.utcDate || undefined,
      status: req.query.status || undefined,
      competition: req.query.competition || undefined,
      homeCrest: req.query.homeCrest || undefined,
      awayCrest: req.query.awayCrest || undefined
    };

    const matchMeta = apiMeta || queryMeta;

    const currentPool = getBetPools(matchId);
    const projectedPool = getBetPools(
      matchId,
      ["home", "draw", "away"].includes(selection) ? selection : null,
      Number.isInteger(stake) && stake > 0 ? stake : 0
    );

    res.json({
      matchId,
      matchMeta,
      currentPool,
      projectedPool
    });
  } catch (error) {
    res.status(500).json({
      error: "베팅 풀 정보를 불러오지 못했습니다.",
      detail: error.message
    });
  }
});

app.post("/api/bets", requireAuth, async (req, res) => {
  try {
    const { matchId, selection, stake, matchMeta } = req.body;

    if (!matchId || !selection || !stake) {
      return res.status(400).json({
        error: "경기, 선택, 베팅 포인트를 모두 입력해야 합니다."
      });
    }

    if (!["home", "draw", "away"].includes(selection)) {
      return res.status(400).json({
        error: "베팅 선택값이 올바르지 않습니다."
      });
    }

    const parsedStake = Number(stake);

    if (!Number.isInteger(parsedStake) || parsedStake < 1) {
      return res.status(400).json({
        error: "베팅 포인트는 1 이상의 정수여야 합니다."
      });
    }

    const apiMatch = await getMatchFromApi(matchId);
    const apiMeta = normalizeMatchMetaFromApi(apiMatch);
    const finalMeta = apiMeta || matchMeta || {};

    const status = apiMatch?.status || finalMeta.status;

    if (["FINISHED", "IN_PLAY", "PAUSED", "LIVE"].includes(status)) {
      return res.status(400).json({
        error: "이미 시작했거나 종료된 경기에는 베팅할 수 없습니다."
      });
    }

    const projectedPool = getBetPools(matchId, selection, parsedStake);
    const projectedOdds = projectedPool.odds[selection] || 1;
    const projectedPayout = Math.floor(parsedStake * projectedOdds);

    const transaction = db.transaction(() => {
      const user = db
        .prepare("SELECT id, points FROM users WHERE id = ?")
        .get(req.user.id);

      if (!user) {
        const error = new Error("사용자를 찾을 수 없습니다.");
        error.statusCode = 404;
        throw error;
      }

      if (user.points < parsedStake) {
        const error = new Error("보유 포인트가 부족합니다.");
        error.statusCode = 400;
        throw error;
      }

      db.prepare(`
        UPDATE users
        SET points = points - ?
        WHERE id = ?
      `).run(parsedStake, req.user.id);

      const result = db.prepare(`
        INSERT INTO bets (
          user_id,
          match_id,
          selection,
          stake,
          odds,
          potential_payout,
          status,
          match_meta,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.user.id,
        String(matchId),
        selection,
        parsedStake,
        projectedOdds,
        projectedPayout,
        "pending",
        JSON.stringify(finalMeta || {}),
        new Date().toISOString()
      );

      return result.lastInsertRowid;
    });

    const betId = transaction();

    const user = db
      .prepare("SELECT id, nickname, age, email, points, created_at FROM users WHERE id = ?")
      .get(req.user.id);

    res.status(201).json({
      message: "베팅이 완료되었습니다.",
      betId,
      projectedOdds,
      projectedPayout,
      pool: getBetPools(matchId),
      user: sanitizeUser(user)
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message || "베팅 처리 중 오류가 발생했습니다.",
      detail: error.statusCode ? undefined : error.message
    });
  }
});

app.get("/api/my-bets", requireAuth, (req, res) => {
  try {
    const bets = db.prepare(`
      SELECT
        id,
        match_id,
        selection,
        stake,
        odds,
        potential_payout,
        actual_payout,
        status,
        match_meta,
        created_at,
        settled_at
      FROM bets
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `).all(req.user.id).map(row => ({
      id: row.id,
      matchId: row.match_id,
      selection: row.selection,
      stake: row.stake,
      odds: row.odds,
      potentialPayout: row.potential_payout,
      actualPayout: row.actual_payout,
      status: row.status,
      matchMeta: safeJsonParse(row.match_meta),
      createdAt: row.created_at,
      settledAt: row.settled_at
    }));

    res.json({
      bets
    });
  } catch (error) {
    res.status(500).json({
      error: "내 베팅 내역을 불러오지 못했습니다.",
      detail: error.message
    });
  }
});

app.post("/api/bets/settle/:matchId", requireAuth, async (req, res) => {
  try {
    if (checkApiKey(res)) return;

    const matchId = String(req.params.matchId);
    const match = await getMatchFromApi(matchId);

    if (!match) {
      return res.status(404).json({
        error: "경기 정보를 찾을 수 없습니다."
      });
    }

    if (match.status !== "FINISHED") {
      return res.status(400).json({
        error: "아직 종료되지 않은 경기입니다."
      });
    }

    const homeScore = match.score?.fullTime?.home;
    const awayScore = match.score?.fullTime?.away;

    if (
      homeScore === null ||
      homeScore === undefined ||
      awayScore === null ||
      awayScore === undefined
    ) {
      return res.status(400).json({
        error: "정산 가능한 스코어 정보가 없습니다."
      });
    }

    const resultSelection = getMatchResultFromScore(homeScore, awayScore);
    const now = new Date().toISOString();

    const settleTransaction = db.transaction(() => {
      const pendingBets = db.prepare(`
        SELECT id, user_id, selection, stake
        FROM bets
        WHERE match_id = ? AND status = 'pending'
      `).all(matchId);

      const totalPool = pendingBets.reduce((sum, bet) => sum + bet.stake, 0);

      const winningPool = pendingBets
        .filter(bet => bet.selection === resultSelection)
        .reduce((sum, bet) => sum + bet.stake, 0);

      let wonCount = 0;
      let lostCount = 0;
      let payoutTotal = 0;

      pendingBets.forEach(bet => {
        if (bet.selection === resultSelection && winningPool > 0) {
          const payout = calcParimutuelPayout(
            bet.stake,
            winningPool,
            totalPool
          );

          db.prepare(`
            UPDATE users
            SET points = points + ?
            WHERE id = ?
          `).run(payout, bet.user_id);

          db.prepare(`
            UPDATE bets
            SET status = 'won',
                actual_payout = ?,
                settled_at = ?
            WHERE id = ?
          `).run(payout, now, bet.id);

          wonCount++;
          payoutTotal += payout;
        } else {
          db.prepare(`
            UPDATE bets
            SET status = 'lost',
                actual_payout = 0,
                settled_at = ?
            WHERE id = ?
          `).run(now, bet.id);

          lostCount++;
        }
      });

      return {
        settledCount: pendingBets.length,
        totalPool,
        winningPool,
        wonCount,
        lostCount,
        payoutTotal
      };
    });

    const result = settleTransaction();

    const user = db
      .prepare("SELECT id, nickname, age, email, points, created_at FROM users WHERE id = ?")
      .get(req.user.id);

    res.json({
      message: "정산이 완료되었습니다.",
      matchResult: resultSelection,
      homeScore,
      awayScore,
      ...result,
      user: sanitizeUser(user)
    });
  } catch (error) {
    res.status(500).json({
      error: "정산 처리 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

/* =========================
   Follow API
========================= */

app.get("/api/follows", requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, item_type, item_id, item_name, item_meta, created_at
      FROM follows
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(req.user.id);

    const follows = rows.map(row => ({
      id: row.id,
      itemType: row.item_type,
      itemId: row.item_id,
      itemName: row.item_name,
      itemMeta: safeJsonParse(row.item_meta),
      createdAt: row.created_at
    }));

    res.json({
      teams: follows.filter(item => item.itemType === "team"),
      players: follows.filter(item => item.itemType === "player")
    });
  } catch (error) {
    res.status(500).json({
      error: "팔로우 목록을 불러오지 못했습니다.",
      detail: error.message
    });
  }
});

app.post("/api/follows", requireAuth, (req, res) => {
  try {
    const { itemType, itemId, itemName, itemMeta } = req.body;

    if (!itemType || !itemId || !itemName) {
      return res.status(400).json({
        error: "팔로우 대상 정보가 부족합니다."
      });
    }

    if (!["team", "player"].includes(itemType)) {
      return res.status(400).json({
        error: "팔로우 타입은 team 또는 player만 가능합니다."
      });
    }

    db.prepare(`
      INSERT INTO follows (user_id, item_type, item_id, item_name, item_meta, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, item_type, item_id)
      DO UPDATE SET
        item_name = excluded.item_name,
        item_meta = excluded.item_meta
    `).run(
      req.user.id,
      itemType,
      String(itemId),
      String(itemName).trim(),
      JSON.stringify(itemMeta || {}),
      new Date().toISOString()
    );

    res.status(201).json({
      message: "팔로우가 완료되었습니다."
    });
  } catch (error) {
    res.status(500).json({
      error: "팔로우 처리 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

app.delete("/api/follows/:itemType/:itemId", requireAuth, (req, res) => {
  try {
    const { itemType, itemId } = req.params;

    if (!["team", "player"].includes(itemType)) {
      return res.status(400).json({
        error: "팔로우 타입은 team 또는 player만 가능합니다."
      });
    }

    db.prepare(`
      DELETE FROM follows
      WHERE user_id = ? AND item_type = ? AND item_id = ?
    `).run(req.user.id, itemType, String(itemId));

    res.json({
      message: "팔로우가 해제되었습니다."
    });
  } catch (error) {
    res.status(500).json({
      error: "팔로우 해제 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

/* =========================
   Like API
========================= */

app.get("/api/likes/:itemType/:itemId", requireAuth, (req, res) => {
  try {
    const { itemType, itemId } = req.params;

    if (!["team", "player", "match"].includes(itemType)) {
      return res.status(400).json({
        error: "좋아요 타입이 올바르지 않습니다."
      });
    }

    res.json(likeInfo(req.user.id, itemType, itemId));
  } catch (error) {
    res.status(500).json({
      error: "좋아요 정보를 불러오지 못했습니다.",
      detail: error.message
    });
  }
});

app.post("/api/likes", requireAuth, (req, res) => {
  try {
    const { itemType, itemId, itemName, itemMeta } = req.body;

    if (!itemType || !itemId || !itemName) {
      return res.status(400).json({
        error: "좋아요 대상 정보가 부족합니다."
      });
    }

    if (!["team", "player", "match"].includes(itemType)) {
      return res.status(400).json({
        error: "좋아요 타입이 올바르지 않습니다."
      });
    }

    const weekKey = getKoreaIsoWeekKey();

    db.prepare(`
      INSERT INTO weekly_likes (user_id, item_type, item_id, item_name, item_meta, week_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, item_type, item_id, week_key)
      DO UPDATE SET
        item_name = excluded.item_name,
        item_meta = excluded.item_meta
    `).run(
      req.user.id,
      itemType,
      String(itemId),
      String(itemName),
      JSON.stringify(itemMeta || {}),
      weekKey,
      new Date().toISOString()
    );

    res.status(201).json({
      message: "좋아요가 반영되었습니다.",
      ...likeInfo(req.user.id, itemType, itemId)
    });
  } catch (error) {
    res.status(500).json({
      error: "좋아요 처리 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

app.delete("/api/likes/:itemType/:itemId", requireAuth, (req, res) => {
  try {
    const { itemType, itemId } = req.params;

    if (!["team", "player", "match"].includes(itemType)) {
      return res.status(400).json({
        error: "좋아요 타입이 올바르지 않습니다."
      });
    }

    const weekKey = getKoreaIsoWeekKey();

    db.prepare(`
      DELETE FROM weekly_likes
      WHERE user_id = ? AND item_type = ? AND item_id = ? AND week_key = ?
    `).run(req.user.id, itemType, String(itemId), weekKey);

    res.json({
      message: "좋아요가 취소되었습니다.",
      ...likeInfo(req.user.id, itemType, itemId)
    });
  } catch (error) {
    res.status(500).json({
      error: "좋아요 취소 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

app.get("/api/hot", requireAuth, (req, res) => {
  try {
    const weekKey = getKoreaIsoWeekKey();

    function getTopByType(itemType) {
      return db.prepare(`
        SELECT item_type, item_id, item_name, item_meta, COUNT(*) AS like_count
        FROM weekly_likes
        WHERE week_key = ? AND item_type = ?
        GROUP BY item_type, item_id
        ORDER BY like_count DESC, MAX(created_at) DESC
        LIMIT 5
      `).all(weekKey, itemType).map(row => ({
        itemType: row.item_type,
        itemId: row.item_id,
        itemName: row.item_name,
        itemMeta: safeJsonParse(row.item_meta),
        likeCount: row.like_count
      }));
    }

    res.json({
      weekKey,
      teams: getTopByType("team"),
      players: getTopByType("player"),
      matches: getTopByType("match")
    });
  } catch (error) {
    res.status(500).json({
      error: "HOT 목록을 불러오지 못했습니다.",
      detail: error.message
    });
  }
});

/* =========================
   Team / Player / Match Comment API
========================= */

app.get("/api/comments/:itemType/:itemId", requireAuth, (req, res) => {
  try {
    const { itemType, itemId } = req.params;

    if (!["team", "player", "match"].includes(itemType)) {
      return res.status(400).json({
        error: "댓글 타입이 올바르지 않습니다."
      });
    }

    res.json({
      weekKey: getKoreaIsoWeekKey(),
      comments: getCommentsForItem(req.user.id, itemType, itemId)
    });
  } catch (error) {
    res.status(500).json({
      error: "댓글을 불러오지 못했습니다.",
      detail: error.message
    });
  }
});

app.post("/api/comments", requireAuth, (req, res) => {
  try {
    const { itemType, itemId, itemName, itemMeta, parentCommentId, body } = req.body;

    if (!itemType || !itemId || !itemName || !body) {
      return res.status(400).json({
        error: "댓글 대상 정보와 댓글 내용을 모두 입력해야 합니다."
      });
    }

    if (!["team", "player", "match"].includes(itemType)) {
      return res.status(400).json({
        error: "댓글 타입이 올바르지 않습니다."
      });
    }

    const commentBody = String(body).trim();

    if (commentBody.length < 1) {
      return res.status(400).json({
        error: "댓글 내용을 입력해야 합니다."
      });
    }

    if (commentBody.length > 500) {
      return res.status(400).json({
        error: "댓글은 500자 이하로 입력해야 합니다."
      });
    }

    const weekKey = getKoreaIsoWeekKey();
    let normalizedParentId = null;

    if (parentCommentId) {
      const parent = db.prepare(`
        SELECT id
        FROM comments
        WHERE id = ?
          AND item_type = ?
          AND item_id = ?
          AND week_key = ?
      `).get(Number(parentCommentId), itemType, String(itemId), weekKey);

      if (!parent) {
        return res.status(400).json({
          error: "대댓글을 달 원댓글을 찾을 수 없습니다."
        });
      }

      normalizedParentId = Number(parentCommentId);
    }

    const result = db.prepare(`
      INSERT INTO comments (
        user_id,
        item_type,
        item_id,
        item_name,
        item_meta,
        parent_comment_id,
        body,
        week_key,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      itemType,
      String(itemId),
      String(itemName),
      JSON.stringify(itemMeta || {}),
      normalizedParentId,
      commentBody,
      weekKey,
      new Date().toISOString()
    );

    res.status(201).json({
      message: "댓글이 등록되었습니다.",
      commentId: result.lastInsertRowid
    });
  } catch (error) {
    res.status(500).json({
      error: "댓글 등록 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

app.get("/api/comment-likes/:commentId", requireAuth, (req, res) => {
  try {
    res.json(commentLikeInfo(req.user.id, Number(req.params.commentId)));
  } catch (error) {
    res.status(500).json({
      error: "댓글 좋아요 정보를 불러오지 못했습니다.",
      detail: error.message
    });
  }
});

app.post("/api/comment-likes/:commentId", requireAuth, (req, res) => {
  try {
    const commentId = Number(req.params.commentId);

    const comment = db.prepare(`
      SELECT id
      FROM comments
      WHERE id = ?
    `).get(commentId);

    if (!comment) {
      return res.status(404).json({
        error: "댓글을 찾을 수 없습니다."
      });
    }

    const weekKey = getKoreaIsoWeekKey();

    db.prepare(`
      INSERT INTO comment_likes (user_id, comment_id, week_key, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, comment_id, week_key)
      DO NOTHING
    `).run(
      req.user.id,
      commentId,
      weekKey,
      new Date().toISOString()
    );

    res.status(201).json({
      message: "댓글 좋아요가 반영되었습니다.",
      ...commentLikeInfo(req.user.id, commentId)
    });
  } catch (error) {
    res.status(500).json({
      error: "댓글 좋아요 처리 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

app.delete("/api/comment-likes/:commentId", requireAuth, (req, res) => {
  try {
    const commentId = Number(req.params.commentId);
    const weekKey = getKoreaIsoWeekKey();

    db.prepare(`
      DELETE FROM comment_likes
      WHERE user_id = ? AND comment_id = ? AND week_key = ?
    `).run(req.user.id, commentId, weekKey);

    res.json({
      message: "댓글 좋아요가 취소되었습니다.",
      ...commentLikeInfo(req.user.id, commentId)
    });
  } catch (error) {
    res.status(500).json({
      error: "댓글 좋아요 취소 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

/* =========================
   Match Room API
========================= */

app.get("/api/match-room/:matchId", requireAuth, (req, res) => {
  try {
    const matchId = String(req.params.matchId);

    const statsRows = db.prepare(`
      SELECT prediction_result AS result, COUNT(*) AS count
      FROM match_predictions
      WHERE match_id = ?
      GROUP BY prediction_result
    `).all(matchId);

    const stats = {
      home: 0,
      draw: 0,
      away: 0
    };

    statsRows.forEach(row => {
      stats[row.result] = row.count;
    });

    const averageScore = db.prepare(`
      SELECT AVG(home_score) AS homeAvg, AVG(away_score) AS awayAvg, COUNT(*) AS count
      FROM match_predictions
      WHERE match_id = ?
    `).get(matchId);

    const myPrediction = db.prepare(`
      SELECT prediction_result, home_score, away_score, updated_at
      FROM match_predictions
      WHERE user_id = ? AND match_id = ?
    `).get(req.user.id, matchId) || null;

    res.json({
      matchId,
      predictionStats: stats,
      averageScore: {
        count: averageScore.count || 0,
        homeAvg: averageScore.homeAvg === null ? null : Number(averageScore.homeAvg).toFixed(1),
        awayAvg: averageScore.awayAvg === null ? null : Number(averageScore.awayAvg).toFixed(1)
      },
      myPrediction,
      pool: getBetPools(matchId),
      comments: getCommentsForItem(req.user.id, "match", matchId),
      like: likeInfo(req.user.id, "match", matchId)
    });
  } catch (error) {
    res.status(500).json({
      error: "경기 창 정보를 불러오지 못했습니다.",
      detail: error.message
    });
  }
});

app.post("/api/match-room/:matchId/prediction", requireAuth, (req, res) => {
  try {
    const matchId = String(req.params.matchId);
    const { predictionResult, homeScore, awayScore, matchMeta } = req.body;

    const parsedHome = Number(homeScore);
    const parsedAway = Number(awayScore);

    if (!["home", "draw", "away"].includes(predictionResult)) {
      return res.status(400).json({
        error: "승/무/패 예측값이 올바르지 않습니다."
      });
    }

    if (
      !Number.isInteger(parsedHome) ||
      !Number.isInteger(parsedAway) ||
      parsedHome < 0 ||
      parsedAway < 0 ||
      parsedHome > 30 ||
      parsedAway > 30
    ) {
      return res.status(400).json({
        error: "스코어는 0부터 30 사이의 정수여야 합니다."
      });
    }

    const validationError = validatePredictionAndScore(
      predictionResult,
      parsedHome,
      parsedAway
    );

    if (validationError) {
      return res.status(400).json({
        error: validationError
      });
    }

    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO match_predictions (
        user_id,
        match_id,
        prediction_result,
        home_score,
        away_score,
        match_meta,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, match_id)
      DO UPDATE SET
        prediction_result = excluded.prediction_result,
        home_score = excluded.home_score,
        away_score = excluded.away_score,
        match_meta = excluded.match_meta,
        updated_at = excluded.updated_at
    `).run(
      req.user.id,
      matchId,
      predictionResult,
      parsedHome,
      parsedAway,
      JSON.stringify(matchMeta || {}),
      now,
      now
    );

    res.json({
      message: "예측이 저장되었습니다."
    });
  } catch (error) {
    res.status(500).json({
      error: "예측 저장 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

/* =========================
   Board API
========================= */

app.get("/api/board/posts", requireAuth, (req, res) => {
  try {
    const posts = db.prepare(`
      SELECT
        p.id,
        p.user_id,
        p.title,
        p.body,
        p.image_url,
        p.created_at,
        p.updated_at,
        u.nickname
      FROM board_posts p
      JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC
      LIMIT 100
    `).all().map(post => ({
      id: post.id,
      userId: post.user_id,
      title: post.title,
      body: post.body,
      imageUrl: post.image_url,
      createdAt: post.created_at,
      updatedAt: post.updated_at,
      nickname: post.nickname,
      like: boardPostLikeInfo(req.user.id, post.id)
    }));

    res.json({
      posts
    });
  } catch (error) {
    res.status(500).json({
      error: "게시글 목록을 불러오지 못했습니다.",
      detail: error.message
    });
  }
});

app.get("/api/board/hot", requireAuth, (req, res) => {
  try {
    const weekKey = getKoreaIsoWeekKey();

    const posts = db.prepare(`
      SELECT
        p.id,
        p.user_id,
        p.title,
        p.body,
        p.image_url,
        p.created_at,
        u.nickname,
        COUNT(l.id) AS like_count
      FROM board_posts p
      JOIN users u ON u.id = p.user_id
      JOIN board_post_likes l ON l.post_id = p.id
      WHERE l.week_key = ?
      GROUP BY p.id
      ORDER BY like_count DESC, p.created_at DESC
      LIMIT 5
    `).all(weekKey).map(post => ({
      id: post.id,
      userId: post.user_id,
      title: post.title,
      body: post.body,
      imageUrl: post.image_url,
      createdAt: post.created_at,
      nickname: post.nickname,
      likeCount: post.like_count,
      like: boardPostLikeInfo(req.user.id, post.id)
    }));

    res.json({
      weekKey,
      posts
    });
  } catch (error) {
    res.status(500).json({
      error: "HOT 게시글을 불러오지 못했습니다.",
      detail: error.message
    });
  }
});

app.get("/api/board/posts/:postId", requireAuth, (req, res) => {
  try {
    const postId = Number(req.params.postId);

    const post = db.prepare(`
      SELECT
        p.id,
        p.user_id,
        p.title,
        p.body,
        p.image_url,
        p.created_at,
        p.updated_at,
        u.nickname
      FROM board_posts p
      JOIN users u ON u.id = p.user_id
      WHERE p.id = ?
    `).get(postId);

    if (!post) {
      return res.status(404).json({
        error: "게시글을 찾을 수 없습니다."
      });
    }

    res.json({
      post: {
        id: post.id,
        userId: post.user_id,
        title: post.title,
        body: post.body,
        imageUrl: post.image_url,
        createdAt: post.created_at,
        updatedAt: post.updated_at,
        nickname: post.nickname,
        like: boardPostLikeInfo(req.user.id, post.id)
      },
      comments: getBoardComments(req.user.id, post.id)
    });
  } catch (error) {
    res.status(500).json({
      error: "게시글을 불러오지 못했습니다.",
      detail: error.message
    });
  }
});

app.post("/api/board/posts", requireAuth, upload.single("image"), (req, res) => {
  try {
    const title = String(req.body.title || "").trim();
    const body = String(req.body.body || "").trim();

    if (title.length < 1) {
      return res.status(400).json({
        error: "제목을 입력해야 합니다."
      });
    }

    if (title.length > 100) {
      return res.status(400).json({
        error: "제목은 100자 이하로 입력해야 합니다."
      });
    }

    if (body.length < 1) {
      return res.status(400).json({
        error: "본문을 입력해야 합니다."
      });
    }

    if (body.length > 3000) {
      return res.status(400).json({
        error: "본문은 3000자 이하로 입력해야 합니다."
      });
    }

    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
    const now = new Date().toISOString();

    const result = db.prepare(`
      INSERT INTO board_posts (user_id, title, body, image_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      title,
      body,
      imageUrl,
      now,
      now
    );

    res.status(201).json({
      message: "게시글이 등록되었습니다.",
      postId: result.lastInsertRowid
    });
  } catch (error) {
    res.status(500).json({
      error: "게시글 등록 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

app.post("/api/board/posts/:postId/like", requireAuth, (req, res) => {
  try {
    const postId = Number(req.params.postId);

    const post = db.prepare(`
      SELECT id
      FROM board_posts
      WHERE id = ?
    `).get(postId);

    if (!post) {
      return res.status(404).json({
        error: "게시글을 찾을 수 없습니다."
      });
    }

    const weekKey = getKoreaIsoWeekKey();

    db.prepare(`
      INSERT INTO board_post_likes (post_id, user_id, week_key, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(post_id, user_id, week_key)
      DO NOTHING
    `).run(
      postId,
      req.user.id,
      weekKey,
      new Date().toISOString()
    );

    res.json({
      message: "게시글 좋아요가 반영되었습니다.",
      ...boardPostLikeInfo(req.user.id, postId)
    });
  } catch (error) {
    res.status(500).json({
      error: "게시글 좋아요 처리 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

app.delete("/api/board/posts/:postId/like", requireAuth, (req, res) => {
  try {
    const postId = Number(req.params.postId);
    const weekKey = getKoreaIsoWeekKey();

    db.prepare(`
      DELETE FROM board_post_likes
      WHERE post_id = ? AND user_id = ? AND week_key = ?
    `).run(postId, req.user.id, weekKey);

    res.json({
      message: "게시글 좋아요가 취소되었습니다.",
      ...boardPostLikeInfo(req.user.id, postId)
    });
  } catch (error) {
    res.status(500).json({
      error: "게시글 좋아요 취소 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

app.post("/api/board/posts/:postId/comments", requireAuth, (req, res) => {
  try {
    const postId = Number(req.params.postId);
    const { body, parentCommentId } = req.body;

    const post = db.prepare(`
      SELECT id
      FROM board_posts
      WHERE id = ?
    `).get(postId);

    if (!post) {
      return res.status(404).json({
        error: "게시글을 찾을 수 없습니다."
      });
    }

    const commentBody = String(body || "").trim();

    if (commentBody.length < 1) {
      return res.status(400).json({
        error: "댓글 내용을 입력해야 합니다."
      });
    }

    if (commentBody.length > 500) {
      return res.status(400).json({
        error: "댓글은 500자 이하로 입력해야 합니다."
      });
    }

    let normalizedParentId = null;

    if (parentCommentId) {
      const parent = db.prepare(`
        SELECT id
        FROM board_comments
        WHERE id = ? AND post_id = ?
      `).get(Number(parentCommentId), postId);

      if (!parent) {
        return res.status(400).json({
          error: "대댓글을 달 원댓글을 찾을 수 없습니다."
        });
      }

      normalizedParentId = Number(parentCommentId);
    }

    const result = db.prepare(`
      INSERT INTO board_comments (post_id, user_id, parent_comment_id, body, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      postId,
      req.user.id,
      normalizedParentId,
      commentBody,
      new Date().toISOString()
    );

    res.status(201).json({
      message: "댓글이 등록되었습니다.",
      commentId: result.lastInsertRowid
    });
  } catch (error) {
    res.status(500).json({
      error: "댓글 등록 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

app.get("/api/board/comments/:commentId/like", requireAuth, (req, res) => {
  try {
    res.json(boardCommentLikeInfo(req.user.id, Number(req.params.commentId)));
  } catch (error) {
    res.status(500).json({
      error: "댓글 좋아요 정보를 불러오지 못했습니다.",
      detail: error.message
    });
  }
});

app.post("/api/board/comments/:commentId/like", requireAuth, (req, res) => {
  try {
    const commentId = Number(req.params.commentId);

    const comment = db.prepare(`
      SELECT id
      FROM board_comments
      WHERE id = ?
    `).get(commentId);

    if (!comment) {
      return res.status(404).json({
        error: "댓글을 찾을 수 없습니다."
      });
    }

    const weekKey = getKoreaIsoWeekKey();

    db.prepare(`
      INSERT INTO board_comment_likes (comment_id, user_id, week_key, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(comment_id, user_id, week_key)
      DO NOTHING
    `).run(
      commentId,
      req.user.id,
      weekKey,
      new Date().toISOString()
    );

    res.json({
      message: "댓글 좋아요가 반영되었습니다.",
      ...boardCommentLikeInfo(req.user.id, commentId)
    });
  } catch (error) {
    res.status(500).json({
      error: "댓글 좋아요 처리 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

app.delete("/api/board/comments/:commentId/like", requireAuth, (req, res) => {
  try {
    const commentId = Number(req.params.commentId);
    const weekKey = getKoreaIsoWeekKey();

    db.prepare(`
      DELETE FROM board_comment_likes
      WHERE comment_id = ? AND user_id = ? AND week_key = ?
    `).run(commentId, req.user.id, weekKey);

    res.json({
      message: "댓글 좋아요가 취소되었습니다.",
      ...boardCommentLikeInfo(req.user.id, commentId)
    });
  } catch (error) {
    res.status(500).json({
      error: "댓글 좋아요 취소 중 오류가 발생했습니다.",
      detail: error.message
    });
  }
});

/* =========================
   Football Data API
========================= */

app.get("/api/standings/:competition", async (req, res) => {
  try {
    const competition = req.params.competition.toUpperCase();

    if (checkCompetition(competition, res)) return;

    const data = await footballDataRequest(
      `https://api.football-data.org/v4/competitions/${competition}/standings`
    );

    const standings =
      data.standings?.find(item => item.type === "TOTAL")?.table ||
      data.standings?.[0]?.table ||
      [];

    res.json({
      competition: data.competition.name,
      season: data.season,
      table: standings.map(item => ({
        position: item.position,
        teamId: item.team.id,
        teamName: item.team.name,
        shortName: item.team.shortName,
        tla: item.team.tla,
        crest: item.team.crest,
        played: item.playedGames,
        form: item.form,
        won: item.won,
        draw: item.draw,
        lost: item.lost,
        goalsFor: item.goalsFor,
        goalsAgainst: item.goalsAgainst,
        goalDifference: item.goalDifference,
        points: item.points
      }))
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: "순위표 요청 실패",
      detail: error.message
    });
  }
});

app.get("/api/matches/:competition", async (req, res) => {
  try {
    const competition = req.params.competition.toUpperCase();

    if (checkCompetition(competition, res)) return;

    const today = new Date();
    const after30Days = new Date();

    after30Days.setDate(today.getDate() + 30);

    const dateFrom = req.query.dateFrom || formatDate(today);
    const dateTo = req.query.dateTo || formatDate(after30Days);
    const status = req.query.status || "SCHEDULED";

    const url =
      `https://api.football-data.org/v4/competitions/${competition}/matches` +
      `?dateFrom=${dateFrom}&dateTo=${dateTo}&status=${status}`;

    const data = await footballDataRequest(url);

    res.json({
      competition: data.competition.name,
      count: data.resultSet.count,
      matches: data.matches.map(match => ({
        id: match.id,
        utcDate: match.utcDate,
        status: match.status,
        matchday: match.matchday,
        stage: match.stage,
        group: match.group,
        homeTeam: match.homeTeam.name,
        awayTeam: match.awayTeam.name,
        homeTeamId: match.homeTeam.id,
        awayTeamId: match.awayTeam.id,
        homeCrest: match.homeTeam.crest,
        awayCrest: match.awayTeam.crest,
        homeScore: match.score?.fullTime?.home,
        awayScore: match.score?.fullTime?.away
      }))
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: "경기 일정 요청 실패",
      detail: error.message
    });
  }
});

app.get("/api/team/:teamId/matches", async (req, res) => {
  try {
    if (checkApiKey(res)) return;

    const teamId = req.params.teamId;
    const status = req.query.status || "SCHEDULED";
    const limit = Number(req.query.limit || 5);

    const data = await footballDataRequest(
      `https://api.football-data.org/v4/teams/${teamId}/matches?status=${status}`
    );

    const matches = data.matches.slice(0, limit).map(match => ({
      id: match.id,
      utcDate: match.utcDate,
      status: match.status,
      competition: match.competition?.name,
      homeTeam: match.homeTeam.name,
      awayTeam: match.awayTeam.name,
      homeScore: match.score?.fullTime?.home,
      awayScore: match.score?.fullTime?.away
    }));

    res.json({
      count: data.resultSet?.count || data.matches.length,
      matches
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: "팀 경기 요청 실패",
      detail: error.message
    });
  }
});

app.get("/api/team/:teamId", async (req, res) => {
  try {
    if (checkApiKey(res)) return;

    const data = await footballDataRequest(
      `https://api.football-data.org/v4/teams/${req.params.teamId}`
    );

    res.json({
      id: data.id,
      name: data.name,
      shortName: data.shortName,
      tla: data.tla,
      crest: data.crest,
      address: data.address,
      phone: data.phone,
      website: data.website,
      email: data.email,
      founded: data.founded,
      clubColors: data.clubColors,
      venue: data.venue,
      squad: (data.squad || []).map(player => ({
        id: player.id,
        name: player.name,
        position: player.position,
        dateOfBirth: player.dateOfBirth,
        nationality: player.nationality,
        role: player.role
      })),
      lastUpdated: data.lastUpdated
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: "팀 세부 정보 요청 실패",
      detail: error.message
    });
  }
});

app.get("/api/scorers/:competition", async (req, res) => {
  try {
    const competition = req.params.competition.toUpperCase();

    if (checkCompetition(competition, res)) return;

    const limit = req.query.limit || "20";

    const data = await footballDataRequest(
      `https://api.football-data.org/v4/competitions/${competition}/scorers?limit=${limit}`
    );

    res.json({
      competition: data.competition.name,
      season: data.season,
      scorers: data.scorers.map(item => ({
        playerId: item.player.id,
        playerName: item.player.name,
        firstName: item.player.firstName,
        lastName: item.player.lastName,
        dateOfBirth: item.player.dateOfBirth,
        nationality: item.player.nationality,
        position: item.player.position,
        teamId: item.team.id,
        teamName: item.team.name,
        teamCrest: item.team.crest,
        goals: item.goals,
        assists: item.assists,
        penalties: item.penalties
      }))
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: "득점 순위 요청 실패",
      detail: error.message
    });
  }
});

app.get("/api/player/:playerId/matches", async (req, res) => {
  try {
    if (checkApiKey(res)) return;

    const playerId = req.params.playerId;
    const status = req.query.status || "FINISHED";
    const limit = Number(req.query.limit || 5);

    const data = await footballDataRequest(
      `https://api.football-data.org/v4/persons/${playerId}/matches?status=${status}`
    );

    const matches = data.matches.slice(0, limit).map(match => ({
      id: match.id,
      utcDate: match.utcDate,
      status: match.status,
      competition: match.competition?.name,
      homeTeam: match.homeTeam.name,
      awayTeam: match.awayTeam.name,
      homeScore: match.score?.fullTime?.home,
      awayScore: match.score?.fullTime?.away
    }));

    res.json({
      count: data.resultSet?.count || data.matches.length,
      matches
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: "선수 경기 요청 실패",
      detail: error.message
    });
  }
});

app.get("/api/player/:playerId", async (req, res) => {
  try {
    if (checkApiKey(res)) return;

    const data = await footballDataRequest(
      `https://api.football-data.org/v4/persons/${req.params.playerId}`
    );

    res.json({
      id: data.id,
      name: data.name,
      firstName: data.firstName,
      lastName: data.lastName,
      dateOfBirth: data.dateOfBirth,
      countryOfBirth: data.countryOfBirth,
      nationality: data.nationality,
      position: data.position,
      shirtNumber: data.shirtNumber,
      lastUpdated: data.lastUpdated
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: "선수 세부 정보 요청 실패",
      detail: error.message
    });
  }
});

app.use((error, req, res, next) => {
  res.status(400).json({
    error: error.message || "요청 처리 중 오류가 발생했습니다."
  });
});

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});