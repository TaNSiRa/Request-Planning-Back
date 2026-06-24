function notFound(req, res) {
  res.status(404).json({ message: "Route not found" });
}

function errorHandler(err, req, res, next) {
  console.error(err);
  if (err.name === "ZodError") {
    return res.status(400).json({ message: "Validation error", issues: err.issues });
  }
  res.status(err.status || 500).json({
    message: err.message || "Internal server error"
  });
}

module.exports = { notFound, errorHandler };
