import express from "express";
import cors from "cors";
import { config } from "./config/config";
import { logger } from "./middleware/logger";
import { errorHandler } from "./middleware/errorHandler"
import healthRouter from "./routes/health";
import analyzeRoute from "./routes/analyze";
import statusRoute from "./routes/status";
import searchRoute from "./routes/search";
import issueMapRoute from "./routes/issueMap";
import fileContentRoute from "./routes/fileContent";
import functionsRoute from "./routes/functions";
import architectureRoute from "./routes/architecture";

const app = express();


app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(logger);

app.use("/health", healthRouter);
app.use("/analyze", analyzeRoute);
app.use("/status", statusRoute);
app.use("/search", searchRoute);
app.use("/issue-map", issueMapRoute);
app.use("/file-content", fileContentRoute);
app.use("/functions", functionsRoute);
app.use("/architecture", architectureRoute);

app.get("/", (req, res) => {
    res.send("CodeMap AI Backend Running");
});

// Error handler (ALWAYS LAST)
app.use(errorHandler);


const server = app.listen(config.app.port, () => {
    // In single-instance environments (like Render Free Tier), start the worker inside the server process
    if (process.env.RUN_WORKER_IN_SERVER === "true") {
        import("./queue/worker").catch(err => {
            console.error("[server] Failed to start inline worker:", err);
        });
    }
});

process.on("SIGINT", () => {
    server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
});