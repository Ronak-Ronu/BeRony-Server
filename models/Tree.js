const mongoose = require("mongoose");

const TreeSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true }, 
  username: { type: String, required: true },
  position: { type: [Number], required: true },
  woodColor: { 
    type: String, 
    default: "#8B5A2B",
    match: /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/
  },
  leafColor: { 
    type: String, 
    default: "#00FF00",
    match: /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/ 
  },
});


const Tree = mongoose.model("Tree", TreeSchema);
module.exports = Tree;
