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

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const PORT = process.env.PORT || 3000;

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

function formatDate(date) {
  return date.toISOString().split("T")[0];
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
  } catch (error) {
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
  } catch (error) {
    const apiError = new Error("football-data API 응답이 JSON 형식이 아닙니다.");
    apiError.status = response.status;
    throw apiError;
  }

  if (!response.ok) {
    const apiError = new Error(data.message || data.error || "football-data API 요청 실패");
    apiError.status = response.status;
    apiError.detail = data;
    throw apiError;
  }

  return data;
}

/* =========================
   Auth API
========================= */

// 회원가입
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

    const existingUser = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(normalizedEmail);

    if (existingUser) {
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

// 로그인
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "이메일과 비밀번호를 모두 입력해야 합니다."
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const plainPassword = String(password);

    const user = db
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(normalizedEmail);

    if (!user) {
      return res.status(401).json({
        error: "이메일 또는 비밀번호가 올바르지 않습니다."
      });
    }

    const isPasswordValid = await bcrypt.compare(
      plainPassword,
      user.password_hash
    );

    if (!isPasswordValid) {
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

// 현재 로그인 사용자
app.get("/api/me", requireAuth, (req, res) => {
  res.json({
    user: sanitizeUser(req.user)
  });
});

// 로그아웃
app.post("/api/logout", (req, res) => {
  clearAuthCookie(res);

  res.json({
    message: "로그아웃되었습니다."
  });
});

/* =========================
   Football API
========================= */

// 순위표
app.get("/api/standings/:competition", async (req, res) => {
  try {
    const competition = req.params.competition.toUpperCase();

    if (checkCompetition(competition, res)) return;

    const url = `https://api.football-data.org/v4/competitions/${competition}/standings`;
    const data = await footballDataRequest(url);

    const standings =
      data.standings?.find(item => item.type === "TOTAL")?.table ||
      data.standings?.[0]?.table ||
      [];

    const table = standings.map(item => ({
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
    }));

    res.json({
      competition: data.competition.name,
      season: data.season,
      table
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: "순위표 요청 실패",
      detail: error.message
    });
  }
});

// 리그 경기 일정
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

    const matches = data.matches.map(match => ({
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
    }));

    res.json({
      competition: data.competition.name,
      count: data.resultSet.count,
      matches
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: "경기 일정 요청 실패",
      detail: error.message
    });
  }
});

// 리그 팀 목록
app.get("/api/teams/:competition", async (req, res) => {
  try {
    const competition = req.params.competition.toUpperCase();

    if (checkCompetition(competition, res)) return;

    const url = `https://api.football-data.org/v4/competitions/${competition}/teams`;
    const data = await footballDataRequest(url);

    const teams = data.teams.map(team => ({
      id: team.id,
      name: team.name,
      shortName: team.shortName,
      tla: team.tla,
      crest: team.crest,
      address: team.address,
      website: team.website,
      founded: team.founded,
      clubColors: team.clubColors,
      venue: team.venue,
      squadCount: team.squad ? team.squad.length : 0
    }));

    res.json({
      competition: data.competition.name,
      season: data.season,
      teams
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: "팀 목록 요청 실패",
      detail: error.message
    });
  }
});

// 팀 세부 정보
app.get("/api/team/:teamId", async (req, res) => {
  try {
    if (checkApiKey(res)) return;

    const teamId = req.params.teamId;
    const url = `https://api.football-data.org/v4/teams/${teamId}`;
    const data = await footballDataRequest(url);

    const squad = (data.squad || []).map(player => ({
      id: player.id,
      name: player.name,
      position: player.position,
      dateOfBirth: player.dateOfBirth,
      nationality: player.nationality,
      role: player.role
    }));

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
      squad,
      lastUpdated: data.lastUpdated
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: "팀 세부 정보 요청 실패",
      detail: error.message
    });
  }
});

// 팀별 경기
app.get("/api/team/:teamId/matches", async (req, res) => {
  try {
    if (checkApiKey(res)) return;

    const teamId = req.params.teamId;
    const status = req.query.status || "SCHEDULED";
    const limit = req.query.limit || "5";

    const url = `https://api.football-data.org/v4/teams/${teamId}/matches?status=${status}&limit=${limit}`;
    const data = await footballDataRequest(url);

    const matches = data.matches.map(match => ({
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
      count: data.resultSet?.count || matches.length,
      matches
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: "팀 경기 요청 실패",
      detail: error.message
    });
  }
});

// 득점 순위
app.get("/api/scorers/:competition", async (req, res) => {
  try {
    const competition = req.params.competition.toUpperCase();

    if (checkCompetition(competition, res)) return;

    const limit = req.query.limit || "20";
    const url = `https://api.football-data.org/v4/competitions/${competition}/scorers?limit=${limit}`;
    const data = await footballDataRequest(url);

    const scorers = data.scorers.map(item => ({
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
    }));

    res.json({
      competition: data.competition.name,
      season: data.season,
      scorers
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: "득점 순위 요청 실패",
      detail: error.message
    });
  }
});

// 선수 세부 정보
app.get("/api/player/:playerId", async (req, res) => {
  try {
    if (checkApiKey(res)) return;

    const playerId = req.params.playerId;
    const url = `https://api.football-data.org/v4/persons/${playerId}`;
    const data = await footballDataRequest(url);

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

// 선수별 경기
app.get("/api/player/:playerId/matches", async (req, res) => {
  try {
    if (checkApiKey(res)) return;

    const playerId = req.params.playerId;
    const status = req.query.status || "FINISHED";
    const limit = req.query.limit || "5";

    const url = `https://api.football-data.org/v4/persons/${playerId}/matches?status=${status}&limit=${limit}`;
    const data = await footballDataRequest(url);

    const matches = data.matches.map(match => ({
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
      count: data.resultSet?.count || matches.length,
      matches
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: "선수 경기 요청 실패",
      detail: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});