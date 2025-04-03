const mongoose = require("mongoose");

const BadgeSchema = new mongoose.Schema({
    name: { type: String, required: true },
    type: { type: String, required: true },
    model: { type: String },
    condition: { type: String },
    threshold: { type: Number }
});


const Badge = mongoose.model("Badge", BadgeSchema);
module.exports = Badge;
