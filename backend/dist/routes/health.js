"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
router.get("/", (req, res) => {
    res.json({
        status: "ok",
        uptime: process.uptime(),
        timestamp: Date.now(),
    });
});
exports.default = router;
