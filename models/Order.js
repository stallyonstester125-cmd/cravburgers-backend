import mongoose from "mongoose";

const orderSchema = new mongoose.Schema(
  {
    orderId: {
      type: String,
      required: true,
      unique: true,
    },
    stripeSessionId: {
      type: String,
      unique: true,
      sparse: true, // COD orders won't have this, sparse allows multiple nulls
    },
    // Logged-in user ka order — guest orders me ye null rehta hai
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    customer: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      email: { type: String },
      address: { type: String, required: true },
      city: { type: String },
    },
    items: [
      {
        id: Number,
        name: String,
        price: String,
        quantity: Number,
      },
    ],
    payment: {
      method: { type: String, default: "COD" },
      transactionId: { type: String },
      status: { type: String, default: "pending" },
    },
    notes: {
      type: String,
      default: "",
    },
    total: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "confirmed", "preparing", "delivered", "cancelled"],
      default: "pending",
    },
  },
  {
    timestamps: true, // createdAt aur updatedAt automatic add hoga
  },
);

const Order = mongoose.model("Order", orderSchema);

export default Order;
