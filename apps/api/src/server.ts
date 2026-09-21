import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { checkInRouter } from "./routes/check-ins.js";
import { taskRouter } from "./routes/tasks.js";
import { startMailAgent } from "./services/mail-agent.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/uploads", express.static(path.resolve(process.env.UPLOAD_DIR ?? "./uploads")));

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.use("/api/tasks", taskRouter);
app.use("/api/check-ins", checkInRouter);

app.use(
  (
    error: Error & { statusCode?: number },
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(error);
    response.status(error.statusCode ?? 500).json({
      message: error.statusCode ? error.message : "服务器内部错误"
    });
  }
);

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
  startMailAgent();
});
