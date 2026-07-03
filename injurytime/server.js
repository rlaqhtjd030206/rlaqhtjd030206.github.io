const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const Database = require("better-sqlite3");
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

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

const db = new Database(DB_FILE);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,
    age INTEGER NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
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
  if (!value) {
    return fallback;
  }

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
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    nickname: user.nickname,
    age: user.age,
    email: user.email,
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
      .prepare("SELECT id, nickname, age, email, created_at FROM users WHERE id = ?")
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
  `).get(commentId, weekKey).count;

  const mine = db.prepare(`
    SELECT id
    FROM comment_likes
    WHERE user_id = ? AND comment_id = ? AND week_key = ?
  `).get(userId, commentId, weekKey);

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

  return rows.map(row => {
    const like = commentLikeInfo(userId, row.id);

    return {
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
      like
    };
  });
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
      INSERT INTO users (nickname, age, email, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      trimmedNickname,
      parsedAge,
      normalizedEmail,
      passwordHash,
      new Date().toISOString()
    );

    const user = db
      .prepare("SELECT id, nickname, age, email, created_at FROM users WHERE id = ?")
      .get(result.lastInsertRowid);

    const token = createToken(user);
    setAuthCookie(res, token);

    res.status(201).json({
      message: "회원가입이 완료되었습니다.",
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
   Weekly Like API
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
        SELECT
          item_type,
          item_id,
          item_name,
          item_meta,
          COUNT(*) AS like_count
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
   Comment API
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
    const {
      itemType,
      itemId,
      itemName,
      itemMeta,
      parentCommentId,
      body
    } = req.body;

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
      `).get(
        Number(parentCommentId),
        itemType,
        String(itemId),
        weekKey
      );

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
      WHERE user_id = ?
        AND comment_id = ?
        AND week_key = ?
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
      SELECT
        AVG(home_score) AS homeAvg,
        AVG(away_score) AS awayAvg,
        COUNT(*) AS count
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
    const limit = req.query.limit || "5";

    const data = await footballDataRequest(
      `https://api.football-data.org/v4/teams/${teamId}/matches?status=${status}&limit=${limit}`
    );

    res.json({
      count: data.resultSet?.count || data.matches.length,
      matches: data.matches.map(match => ({
        id: match.id,
        utcDate: match.utcDate,
        status: match.status,
        competition: match.competition?.name,
        homeTeam: match.homeTeam.name,
        awayTeam: match.awayTeam.name,
        homeScore: match.score?.fullTime?.home,
        awayScore: match.score?.fullTime?.away
      }))
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
    const limit = req.query.limit || "5";

    const data = await footballDataRequest(
      `https://api.football-data.org/v4/persons/${playerId}/matches?status=${status}&limit=${limit}`
    );

    res.json({
      count: data.resultSet?.count || data.matches.length,
      matches: data.matches.map(match => ({
        id: match.id,
        utcDate: match.utcDate,
        status: match.status,
        competition: match.competition?.name,
        homeTeam: match.homeTeam.name,
        awayTeam: match.awayTeam.name,
        homeScore: match.score?.fullTime?.home,
        awayScore: match.score?.fullTime?.away
      }))
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

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});