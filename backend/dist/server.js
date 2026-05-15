"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const config_1 = require("./config/config");
const logger_1 = require("./middleware/logger");
const errorHandler_1 = require("./middleware/errorHandler");
const health_1 = __importDefault(require("./routes/health"));
const analyze_1 = __importDefault(require("./routes/analyze"));
const status_1 = __importDefault(require("./routes/status"));
const search_1 = __importDefault(require("./routes/search"));
const issueMap_1 = __importDefault(require("./routes/issueMap"));
const fileContent_1 = __importDefault(require("./routes/fileContent"));
const functions_1 = __importDefault(require("./routes/functions"));
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: "5mb" }));
app.use(logger_1.logger);
app.use("/health", health_1.default);
app.use("/analyze", analyze_1.default);
app.use("/status", status_1.default);
app.use("/search", search_1.default);
app.use("/issue-map", issueMap_1.default);
app.use("/file-content", fileContent_1.default);
app.use("/functions", functions_1.default);
app.get("/", (req, res) => {
    res.send("CodeMap AI Backend Running");
});
// Error handler (ALWAYS LAST)
app.use(errorHandler_1.errorHandler);
const server = app.listen(config_1.config.app.port, () => {
    console.log(`Server running on http://localhost:${config_1.config.app.port}`);
});
process.on("SIGINT", () => {
    server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
});
