import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import Stripe from "stripe";
import Order from "./models/Order.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ============ STRIPE INITIALIZATION ============
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============ MIDDLEWARE ============
app.use(
  cors({
    origin: [
      "https://lambent-marshmallow-d41308.netlify.app",
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175",
    ],
    credentials: true,
  }),
);

// NOTE: express.json() is applied globally EXCEPT for the webhook route,
// which needs the raw body for signature verification. We register the
// webhook route BEFORE express.json() so it gets the raw body.

// ============ STRIPE WEBHOOK (Payment Success) ============
// IMPORTANT: This must come BEFORE app.use(express.json())
app.post(
  "/api/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    const sig = req.headers["stripe-signature"];

    try {
      if (process.env.STRIPE_WEBHOOK_SECRET) {
        // ✅ Proper verification — confirms the event genuinely came from Stripe
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET,
        );
      } else {
        console.warn(
          "⚠️ STRIPE_WEBHOOK_SECRET not set — skipping signature verification (unsafe for production)",
        );
        event = JSON.parse(req.body);
      }
    } catch (err) {
      console.error("❌ Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`📩 Webhook received: ${event.type}`);

    // Handle checkout.session.completed event
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      try {
        // ✅ IDEMPOTENCY CHECK — agar is session ke liye order pehle se hai to skip karo
        const existingOrder = await Order.findOne({
          stripeSessionId: session.id,
        });

        if (existingOrder) {
          console.log(
            `⚠️ Duplicate webhook — order already exists for session ${session.id}, skipping`,
          );
          return res.json({ received: true });
        }

        const {
          customer_name,
          customer_phone,
          customer_address,
          customer_notes,
        } = session.metadata;

        const lineItems = await stripe.checkout.sessions.listLineItems(
          session.id,
        );

        const items = lineItems.data.map((item) => ({
          name: item.description,
          quantity: item.quantity,
          price: item.amount_total / 100 / item.quantity,
        }));

        const total = session.amount_total / 100;

        const newOrder = new Order({
          orderId: `CRAV-${Date.now()}`,
          stripeSessionId: session.id, // ✅ used for idempotency check above
          customer: {
            name: customer_name,
            phone: customer_phone,
            address: customer_address,
          },
          items: items,
          payment: {
            method: "stripe",
            transactionId: session.payment_intent,
            status: "paid",
          },
          notes: customer_notes || "",
          total: total,
          status: "confirmed",
        });

        await newOrder.save();
        console.log(`✅ Order created via Stripe: ${newOrder.orderId}`);
      } catch (error) {
        console.error("Error saving order from webhook:", error);
      }
    }

    res.json({ received: true });
  },
);

// Regular JSON parsing for all other routes
app.use(express.json());

// ============ MONGODB CONNECTION ============
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB Atlas");
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
  });

// ============ ROUTES ============

// Health check
app.get("/", (req, res) => {
  res.json({ message: "CRAV Burgers API is running 🍔" });
});

// ============ STRIPE CHECKOUT SESSION ============
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    console.log("📦 Full Request Body:", JSON.stringify(req.body, null, 2));

    const { items, customer } = req.body;

    // Check if items exist
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Cart is empty",
      });
    }

    // Check if customer data exists
    if (!customer || !customer.name || !customer.phone || !customer.address) {
      return res.status(400).json({
        success: false,
        error: "Customer information is incomplete",
      });
    }

    // ✅ Dynamic BASE URL - Production aur Development ke liye
    const BASE_URL =
      process.env.NODE_ENV === "production"
        ? "https://lambent-marshmallow-d41308.netlify.app"
        : process.env.BASE_URL || "http://localhost:5173";

    console.log(`🌐 Using BASE_URL: ${BASE_URL}`);

    // Convert cart items to Stripe line_items format
    const line_items = items.map((item) => ({
      price_data: {
        currency: "usd",
        product_data: {
          name: item.name,
          images: item.image ? [item.image] : [],
        },
        unit_amount: Math.round(Number(item.price) * 100), // Convert to cents
      },
      quantity: Number(item.quantity),
    }));

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: line_items,
      mode: "payment",
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cancel`,
      metadata: {
        customer_name: customer.name,
        customer_phone: customer.phone,
        customer_address: customer.address,
        customer_notes: customer.notes || "",
      },
      shipping_address_collection: {
        allowed_countries: ["US", "CA", "GB", "PK", "IN", "AE"],
      },
    });

    console.log(`✅ Stripe session created: ${session.id}`);

    // ✅ Send both sessionId and URL
    res.json({
      success: true,
      sessionId: session.id,
      url: session.url,
    });
  } catch (error) {
    console.error("❌ Stripe session creation error:", error);
    console.error("Error details:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============ VERIFY PAYMENT STATUS ============
app.get("/api/verify-payment/:sessionId", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(
      req.params.sessionId,
    );

    res.json({
      success: true,
      paid: session.payment_status === "paid",
      status: session.payment_status,
      customer: session.customer_details,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============ ADMIN LOGIN ============
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      error: "Username and password required",
    });
  }

  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    console.log(`🔐 Admin logged in`);
    return res.json({ success: true });
  }

  return res.status(401).json({
    success: false,
    error: "Invalid credentials",
  });
});

// ============ ORDER ROUTES ============

// GET all orders
app.get("/api/orders", async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    const formatted = orders.map((o) => ({
      id: o.orderId,
      customer: o.customer,
      items: o.items,
      payment: o.payment,
      notes: o.notes,
      total: o.total,
      status: o.status,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    }));
    res.json({ success: true, orders: formatted });
  } catch (err) {
    console.error("Error fetching orders:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST new order (COD)
app.post("/api/orders", async (req, res) => {
  try {
    const { customer, items, payment, notes, total } = req.body;

    if (!customer || !items || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields (customer or items)",
      });
    }

    if (!customer.name || !customer.phone || !customer.address) {
      return res.status(400).json({
        success: false,
        error: "Customer name, phone, and address are required",
      });
    }

    const newOrder = new Order({
      orderId: `CRAV-${Date.now()}`,
      customer,
      items,
      payment: payment || { method: "COD", status: "pending" },
      notes: notes || "",
      total,
      status: "pending",
    });

    await newOrder.save();

    console.log(`✅ New order received: ${newOrder.orderId}`);

    res.status(201).json({
      success: true,
      message: "Order placed successfully!",
      order: {
        id: newOrder.orderId,
        customer: newOrder.customer,
        items: newOrder.items,
        payment: newOrder.payment,
        notes: newOrder.notes,
        total: newOrder.total,
        status: newOrder.status,
        createdAt: newOrder.createdAt,
      },
    });
  } catch (err) {
    console.error("Error creating order:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET single order
app.get("/api/orders/:id", async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.id });
    if (!order) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }
    res.json({
      success: true,
      order: {
        id: order.orderId,
        customer: order.customer,
        items: order.items,
        payment: order.payment,
        notes: order.notes,
        total: order.total,
        status: order.status,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// UPDATE order status
app.patch("/api/orders/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = [
      "pending",
      "confirmed",
      "preparing",
      "delivered",
      "cancelled",
    ];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      });
    }

    const order = await Order.findOneAndUpdate(
      { orderId: req.params.id },
      { status },
      { new: true },
    );

    if (!order) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }

    console.log(`📝 Order ${req.params.id} status updated to: ${status}`);

    res.json({
      success: true,
      order: {
        id: order.orderId,
        customer: order.customer,
        items: order.items,
        payment: order.payment,
        notes: order.notes,
        total: order.total,
        status: order.status,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE order
app.delete("/api/orders/:id", async (req, res) => {
  try {
    const order = await Order.findOneAndDelete({ orderId: req.params.id });

    if (!order) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }

    console.log(`🗑️  Order ${req.params.id} deleted`);

    res.json({ success: true, message: "Order deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 CRAV API running on http://localhost:${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || "development"}`);
});
