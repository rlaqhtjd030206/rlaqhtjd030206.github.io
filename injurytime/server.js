const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.static("public"));

const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const PORT = process.env.PORT || 3000;

const allowedCompetitions = ["PL", "PD", "BL1", "SA", "FL1"];

app.get("/api/standings/:competition", async (req, res) => {
  try {
    const competition = req.params.competition.toUpperCase();

    if (!allowedCompetitions.includes(competition)) {
      return res.status(400).json({
        error: "지원하지 않는 리그 코드입니다."
      });
    }

    if (!API_KEY) {
      return res.status(500).json({
        error: ".env 파일에 FOOTBALL_DATA_API_KEY가 없습니다."
      });
    }

    const response = await fetch(
      `https://api.football-data.org/v4/competitions/${competition}/standings`,
      {
        headers: {
          "X-Auth-Token": API_KEY
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "football-data API 요청 실패",
        detail: data.message || data.error || data
      });
    }

    const standings = data.standings?.[0]?.table || [];

    const table = standings.map(item => ({
      position: item.position,
      teamName: item.team.name,
      crest: item.team.crest,
      played: item.playedGames,
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
      table
    });
  } catch (error) {
    res.status(500).json({
      error: "서버 내부 오류",
      detail: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});