"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
function errorHandler(err, req, res, next) {
    const status = err.status || 500;
    res.status(status).json({
        error: {
            message: err.message || "Internal Server Error",
            ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
        },
    });
}
