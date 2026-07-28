import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import Stripe from "stripe";
import Order from "./models/Order.js";
import Product from "./models/Product.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "./models/User.js";

dotenv.config();

if (!process.env.JWT_SECRET) {
  console.error(
    "❌ JWT_SECRET is not set. Add it to .env (local) or to your host's environment variables.",
  );
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5000;

// ============ STRIPE INITIALIZATION ============
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============ ALLOWED ORIGINS (used for CORS and Stripe redirect validation) ============
const ALLOWED_ORIGINS = [
  "https://lambent-marshmallow-d41308.netlify.app",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
];

// ============ MIDDLEWARE ============
app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  }),
);

// NOTE: express.json() is applied globally EXCEPT for the webhook route,
// which needs the raw body for signature verification. We register the
// webhook route BEFORE express.json() so it gets the raw body.

// ============ STRIPE WEBHOOK (Payment Success) ============
// IMPORTANT: This must come BEFORE app.use(express.json())

// ============ AUTH MIDDLEWARE ============
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, error: "No token provided" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, role }
    next();
  } catch (err) {
    return res
      .status(401)
      .json({ success: false, error: "Invalid or expired token" });
  }
}

// Token ho to req.user set karta hai, na ho to bhi request aage jaane deta hai.
// Guest checkout isi wajah se chalta rehta hai.
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      req.user = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
    } catch {
      // Invalid/expired token — guest ki tarah treat karo, error mat do
      req.user = null;
    }
  }
  next();
}

// Sirf admin — orders aur products ke management routes ke liye
function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user?.role !== "admin") {
      return res
        .status(403)
        .json({ success: false, error: "Admin access required" });
    }
    next();
  });
}

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
          customer_email,
          customer_notes,
          user_id,
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
          user: user_id || null,
          customer: {
            name: customer_name,
            phone: customer_phone,
            address: customer_address,
            email: customer_email || session.customer_details?.email || "",
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
app.post("/api/create-checkout-session", optionalAuth, async (req, res) => {
  try {
    console.log("📦 Full Request Body:", JSON.stringify(req.body, null, 2));

    const { items, customer, origin } = req.body;

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

    // ✅ Use the origin the request actually came from (validated against the
    // allowlist) so Stripe redirects back to localhost during local testing
    // and to the live domain in production — instead of always using one or
    // the other based on NODE_ENV.
    const BASE_URL = ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0];

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
        customer_email: customer.email || "",
        customer_notes: customer.notes || "",
        // Logged-in ho to webhook order ko isi account se link kar dega
        user_id: req.user?.id || "",
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

  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    console.error("❌ ADMIN_USERNAME / ADMIN_PASSWORD env me set nahi hain");
    return res
      .status(500)
      .json({ success: false, error: "Admin login not configured" });
  }

  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    console.log(`🔐 Admin logged in`);
    // Admin ko bhi asli JWT do — pehle sirf frontend localStorage flag tha,
    // is liye API bilkul khuli hui thi.
    const token = jwt.sign({ id: "admin", role: "admin" }, process.env.JWT_SECRET, {
      expiresIn: "12h",
    });
    return res.json({ success: true, token });
  }

  return res.status(401).json({
    success: false,
    error: "Invalid credentials",
  });
});

// ============ USER AUTH ROUTES ============

// Register (signup)
// User object ka wo shape jo frontend ko bhejna safe hai (password kabhi nahi)
function publicUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    address: user.address,
    city: user.city,
    role: user.role,
  };
}

// Account banne/login hone se pehle jo guest orders isi email/phone se aaye thay,
// unhe is account se jod do — taake dashboard me purani history bhi dikhe.
async function linkGuestOrders(user) {
  // Guest ne email jis case me likhi thi wo waise hi save hui hai
  // ("Ali@X.com"), is liye case-insensitive match karo
  const escaped = user.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = [{ "customer.email": new RegExp(`^${escaped}$`, "i") }];
  if (user.phone) match.push({ "customer.phone": user.phone });

  try {
    const result = await Order.updateMany(
      { user: null, $or: match },
      { $set: { user: user._id } },
    );
    if (result.modifiedCount > 0) {
      console.log(
        `🔗 ${result.modifiedCount} guest order(s) linked to ${user.email}`,
      );
    }
  } catch (err) {
    // Linking fail ho to login/register nahi rukna chahiye
    console.error("Guest order linking failed:", err.message);
  }
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, phone, address, city } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        error: "Name, email, and password are required",
      });
    }
    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: "Password must be at least 6 characters",
      });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: "An account with this email already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      name,
      email: email.toLowerCase(),
      password: hashedPassword,
      phone: phone || "",
      address: address || "",
      city: city || "",
      role: "user",
    });
    // Token pehle banao — agar JWT_SECRET missing hai to adhoora account na bane
    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    await user.save();
    await linkGuestOrders(user);

    console.log(`👤 New user registered: ${user.email}`);

    res.status(201).json({
      success: true,
      token,
      user: publicUser(user),
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email and password are required",
      });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res
        .status(401)
        .json({ success: false, error: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res
        .status(401)
        .json({ success: false, error: "Invalid email or password" });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    await linkGuestOrders(user);

    console.log(`🔓 User logged in: ${user.email}`);

    res.json({
      success: true,
      token,
      user: publicUser(user),
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Current logged-in user (protected — token chahiye)
app.get("/api/auth/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }
    res.json({ success: true, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ PRODUCT ROUTES ============

// GET all products (public — used by the menu/homepage)
app.get("/api/products", async (req, res) => {
  try {
    // Only return active products to the public site, sorted by display order
    const products = await Product.find({ isActive: true }).sort({
      order: 1,
      createdAt: 1,
    });
    res.json({ success: true, products });
  } catch (err) {
    console.error("Error fetching products:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET all products including inactive ones (for admin panel)
app.get("/api/admin/products", adminMiddleware, async (req, res) => {
  try {
    const products = await Product.find().sort({ order: 1, createdAt: 1 });
    res.json({ success: true, products });
  } catch (err) {
    console.error("Error fetching products:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET single product
app.get("/api/products/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res
        .status(404)
        .json({ success: false, error: "Product not found" });
    }
    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST create new product (admin)
app.post("/api/products", adminMiddleware, async (req, res) => {
  try {
    const { name, tagline, price, img, tag, bgColor, order, isActive } =
      req.body;

    if (!name || !price || !img) {
      return res.status(400).json({
        success: false,
        error: "Name, price, and image are required",
      });
    }

    const newProduct = new Product({
      name,
      tagline: tagline || "",
      price,
      img,
      tag: tag || "",
      bgColor: bgColor || "#ee2b1e",
      order: order ?? 0,
      isActive: isActive ?? true,
    });

    await newProduct.save();

    console.log(`✅ New product created: ${newProduct.name}`);

    res.status(201).json({ success: true, product: newProduct });
  } catch (err) {
    console.error("Error creating product:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT update product (admin)
app.put("/api/products/:id", adminMiddleware, async (req, res) => {
  try {
    const { name, tagline, price, img, tag, bgColor, order, isActive } =
      req.body;

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { name, tagline, price, img, tag, bgColor, order, isActive },
      { new: true, runValidators: true },
    );

    if (!product) {
      return res
        .status(404)
        .json({ success: false, error: "Product not found" });
    }

    console.log(`📝 Product updated: ${product.name}`);

    res.json({ success: true, product });
  } catch (err) {
    console.error("Error updating product:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE product (admin)
app.delete("/api/products/:id", adminMiddleware, async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);

    if (!product) {
      return res
        .status(404)
        .json({ success: false, error: "Product not found" });
    }

    console.log(`🗑️  Product deleted: ${product.name}`);

    res.json({ success: true, message: "Product deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ ORDER ROUTES ============

function formatOrder(o) {
  return {
    id: o.orderId,
    customer: o.customer,
    items: o.items,
    payment: o.payment,
    notes: o.notes,
    total: o.total,
    status: o.status,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

// GET all orders (admin only — isme har customer ka naam, phone aur address hai)
app.get("/api/orders", adminMiddleware, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json({ success: true, orders: orders.map(formatOrder) });
  } catch (err) {
    console.error("Error fetching orders:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET logged-in user ke apne orders — user dashboard isay use karta hai.
// NOTE: ye "/api/orders/:id" se PEHLE hona zaroori hai, warna "my" ko
// order id samajh liya jayega.
app.get("/api/orders/my", authMiddleware, async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user.id }).sort({
      createdAt: -1,
    });
    res.json({ success: true, orders: orders.map(formatOrder) });
  } catch (err) {
    console.error("Error fetching user orders:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST new order (COD) — optionalAuth: guest bhi order kar sakta hai,
// logged-in ho to order uske account se link ho jata hai
app.post("/api/orders", optionalAuth, async (req, res) => {
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
      user: req.user?.id || null,
      customer,
      items,
      payment: payment || { method: "COD", status: "pending" },
      notes: notes || "",
      total,
      status: "pending",
    });

    await newOrder.save();

    // Logged-in user ka address yaad rakho — agli baar checkout prefill ho jayega
    if (req.user?.id) {
      await User.findByIdAndUpdate(req.user.id, {
        address: customer.address,
        city: customer.city || "",
        ...(customer.phone ? { phone: customer.phone } : {}),
      }).catch((err) =>
        console.error("Profile address update failed:", err.message),
      );
    }

    console.log(
      `✅ New order received: ${newOrder.orderId}${req.user?.id ? " (user linked)" : " (guest)"}`,
    );

    res.status(201).json({
      success: true,
      message: "Order placed successfully!",
      order: formatOrder(newOrder),
    });
  } catch (err) {
    console.error("Error creating order:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET single order
app.get("/api/orders/:id", optionalAuth, async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.id });
    if (!order) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }

    // Agar order kisi account se linked hai to sirf wohi user (ya admin) dekh sake.
    // Guest orders khule rehte hain — order-confirmation page ko chahiye hote hain.
    if (order.user) {
      const isOwner = req.user && String(order.user) === String(req.user.id);
      const isAdmin = req.user?.role === "admin";
      if (!isOwner && !isAdmin) {
        return res
          .status(403)
          .json({ success: false, error: "Not allowed to view this order" });
      }
    }

    res.json({ success: true, order: formatOrder(order) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// UPDATE order status (admin only)
app.patch("/api/orders/:id/status", adminMiddleware, async (req, res) => {
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

    res.json({ success: true, order: formatOrder(order) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE order (admin only)
app.delete("/api/orders/:id", adminMiddleware, async (req, res) => {
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
