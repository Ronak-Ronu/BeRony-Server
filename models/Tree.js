const mongoose = require("mongoose");

const ItemSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: { type: String, required: true },
  itemType: { 
    type: String, 
    required: true, 
    enum: ['tree', 'flower', 'bench', 'swingSet'] 
  },
  position: { type: [Number], required: true },
  woodColor: { 
    type: String, 
    match: /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/,
    default: null
  },
  leafColor: { 
    type: String, 
    match: /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/,
    default: null
  },
});

const Item = mongoose.model("Item", ItemSchema);
module.exports = Item;