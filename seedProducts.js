// Run this once with: node seedProducts.js
// Make sure your .env file (with MONGODB_URI) is in the same folder.

import mongoose from "mongoose";
import dotenv from "dotenv";
import Product from "./models/Product.js";

dotenv.config();

const PRODUCTS = [
  {
    name: "Classic Smash",
    tagline: "The Original",
    price: "$8.99",
    img: "https://www.cravburgers.shop/_next/image?url=%2Fimg-webp%2Fabout-2.webp&w=2048&q=75",
    tag: "BESTSELLER",
    bgColor: "#ee2b1e",
    order: 1,
  },
  {
    name: "Double Cheese",
    tagline: "Cheesy Meltdown",
    price: "$11.99",
    img: "https://www.cravburgers.shop/_next/image?url=%2Fimg-webp%2FcheesyBurger.webp&w=2048&q=75",
    tag: "NEW",
    bgColor: "#f5c842",
    order: 2,
  },
  {
    name: "Bacon King",
    tagline: "Bacon Overload",
    price: "$12.99",
    img: "https://www.cravburgers.shop/_next/image?url=%2Fimg-webp%2Fabout-3.webp&w=2048&q=75",
    tag: "SPICY",
    bgColor: "#ee2b1e",
    order: 3,
  },
  {
    name: "Veggie Delight",
    tagline: "Plant Powered",
    price: "$9.99",
    img: "https://www.cravburgers.shop/_next/image?url=%2Fimg-webp%2Fabout-1.webp&w=2048&q=75",
    tag: "HEALTHY",
    bgColor: "#7cb342",
    order: 4,
  },
  {
    name: "Spicy Inferno",
    tagline: "Hot & Bold",
    price: "$10.99",
    img: "https://www.cravburgers.shop/_next/image?url=%2Fimg-webp%2Fcta.webp&w=2048&q=75",
    tag: "HOT",
    bgColor: "#ee2b1e",
    order: 5,
  },
  {
    name: "Ultimate Combo",
    tagline: "Full Meal Deal",
    price: "$15.99",
    img: "https://www.cravburgers.shop/_next/image?url=%2Fimg-webp%2Fburgerwithhands.webp&w=2048&q=75",
    tag: "COMBO",
    bgColor: "#f5c842",
    order: 6,
  },
];

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connected to MongoDB");

    const existingCount = await Product.countDocuments();
    if (existingCount > 0) {
      console.log(
        `⚠️ Products collection already has ${existingCount} product(s).`,
      );
      console.log(
        "If you want to re-seed anyway, delete existing products first (via admin panel or DB) and run this script again.",
      );
      process.exit(0);
    }

    await Product.insertMany(PRODUCTS);
    console.log(`✅ Seeded ${PRODUCTS.length} products successfully!`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Seeding failed:", err);
    process.exit(1);
  }
}

seed();
