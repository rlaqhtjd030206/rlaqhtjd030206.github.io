const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.static("public"));

const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const PORT = process.env.PORT || 3000;

const allowedCompetitions = ["PL", "PD", "BL1", "SA", "FL1"];

function formatDate(date) {
  return date.toISOString().split("T")[0];
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

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data.message || data.error || "football-data API 요청 실패");
    error.status = response.status;
    error.detail = data;
    throw error;
  }

  return data;
}

// 순위표 API
app.get("/api/standings/:competition", async (req, res) => {
  try {
    const competition = req.params.competition.toUpperCase();

    if (checkCompetition(competition, res)) return;

    const url = `https://api.football-data.org/v4/competitions/${competition}/standings`;
    const data = await footballDataRequest(url);

    const standings = data.standings?.find(item => item.type === "TOTAL")?.table || data.standings?.[0]?.table || [];

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

// 리그 경기 일정 API
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

// 리그 팀 목록 API
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

// 팀 세부 정보 API
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

// 팀별 경기 API
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

// 득점 순위 API
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

// 선수 세부 정보 API
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

// 선수별 경기 API
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