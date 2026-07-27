import mongoose from "mongoose";

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    tagline: {
      type: String,
      default: "",
    },
    price: {
      type: String, // stored like "$8.99" to match the rest of the app (cart, checkout)
      required: true,
    },
    img: {
      type: String,
      required: true,
    },
    tag: {
      type: String, // e.g. "BESTSELLER", "NEW", "SPICY"
      default: "",
    },
    bgColor: {
      type: String, // hex color, e.g. "#ee2b1e"
      default: "#ee2b1e",
    },
    order: {
      type: Number, // controls display order on the menu
      default: 0,
    },
    isActive: {
      type: Boolean, // lets admin hide a product without deleting it
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

const Product = mongoose.model("Product", productSchema);

export default Product;
