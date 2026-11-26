"use strict";

module.exports = (req, res, next) => {
    if (req.user && req.user.role === "admin") return next();
    return res.status(403).json({ ok: false, error: "Administrator access required." });
};
