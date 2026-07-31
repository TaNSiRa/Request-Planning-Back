function notFound(req, res) {
  res.status(404).json({ message: "Route not found" });
}

// Errors the app raises on purpose carry err.status (403 "Only the assigned
// incharge…", 404 "Request not found", 409 "EMAIL_TAKEN", …) and the frontend
// shows that text to the user, so those messages must pass through unchanged.
// Anything WITHOUT a deliberate 4xx status is an unexpected failure — a mssql
// driver error, a null dereference — whose message can leak table and column
// names, file paths, or connection details. Those get a generic message; the
// real one stays in the server log.
function errorHandler(err, req, res, next) {
  console.error(err);
  if (err.name === "ZodError") {
    return res.status(400).json({ message: "Validation error", issues: err.issues });
  }
  const status = Number(err.status) || 500;
  const isIntentional = status >= 400 && status < 500;
  res.status(status).json({
    message: isIntentional && err.message ? err.message : "Internal server error"
  });
}

module.exports = { notFound, errorHandler };
