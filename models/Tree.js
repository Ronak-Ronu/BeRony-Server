const mongoose = require("mongoose");

const TreeSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true }, // One tree per user
  username: { type: String, required: true },
  position: { type: [Number], required: true }, // [x, y, z]
  woodColor: { type: String, default: "#8B5A2B" }, // Default brown wood
  leafColor: { type: String, default: "green" },
});

const Tree = mongoose.model("Tree", TreeSchema);
module.exports = Tree;
