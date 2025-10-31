const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();

const app = express();

// ✅ Middlewares
app.use(cors());
app.use(bodyParser.json());

// ✅ MongoDB Connection
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// ✅ Schema & Model
const transactionSchema = new mongoose.Schema({
  MerchantRequestID: String,
  CheckoutRequestID: String,
  ResultCode: Number,
  ResultDesc: String,
  Amount: Number,
  MpesaReceiptNumber: String,
  TransactionDate: String,
  PhoneNumber: String,
  rawCallback: Object,
});

const Transaction = mongoose.model("Transaction", transactionSchema);

// ✅ Env variables
const {
  CONSUMER_KEY,
  CONSUMER_SECRET,
  SHORTCODE,
  PASSKEY,
  CALLBACK_URL,
  MPESA_ENV,
} = process.env;

// ✅ Base URL (Sandbox or Live)
const baseURL =
  MPESA_ENV === "live"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

// ✅ Sanitize XML
function sanitizeXml(str = "") {
  return str.replace(
    /[&<>'"]/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&apos;",
        '"': "&quot;",
      }[c])
  );
}

// 🔹 Get Access Token
app.get("/token", async (req, res) => {
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString(
    "base64"
  );
  try {
    const { data } = await axios.get(
      `${baseURL}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    res.json(data);
  } catch (error) {
    res.status(500).json({
      message: "Failed to get access token",
      error: error.response?.data || error.message,
    });
  }
});

// 🔹 STK Push
app.post("/stkpush", async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) {
    return res.status(400).json({ message: "Phone and amount required" });
  }

  try {
    // 1️⃣ Get Access Token
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString(
      "base64"
    );
    const { data: tokenData } = await axios.get(
      `${baseURL}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    const accessToken = tokenData.access_token;

    // 2️⃣ Timestamp & Password
    const timestamp = new Date()
      .toISOString()
      .replace(/[-T:.Z]/g, "")
      .slice(0, 14);
    const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString(
      "base64"
    );

    // 3️⃣ Payload
    const payload = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerBuyGoodsOnline",
      Amount: amount,
      PartyA: sanitizeXml(phone.toString()),
      PartyB: "8341270",
      PhoneNumber: sanitizeXml(phone.toString()),
      CallBackURL: sanitizeXml(CALLBACK_URL),
      AccountReference: "RichTech Bundles",
      TransactionDesc: "Bundle Purchase",
    };

    // 4️⃣ Request to Safaricom
    const { data: stkResponse } = await axios.post(
      `${baseURL}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    res.json(stkResponse);
  } catch (error) {
    console.error("💥 STK Push error:", error.response?.data || error.message);
    res.status(500).json({
      message: "STK Push failed",
      error: error.response?.data || error.message,
    });
  }
});

// 🔹 Callback from Safaricom
app.post("/callbackurl", async (req, res) => {
  console.log("✅ Callback Received:", JSON.stringify(req.body, null, 2));
  try {
    const callback = req.body.Body.stkCallback;
    const newTransaction = new Transaction({
      MerchantRequestID: sanitizeXml(callback.MerchantRequestID),
      CheckoutRequestID: sanitizeXml(callback.CheckoutRequestID),
      ResultCode: callback.ResultCode,
      ResultDesc: sanitizeXml(callback.ResultDesc),
      Amount:
        callback.CallbackMetadata?.Item?.find((i) => i.Name === "Amount")
          ?.Value || 0,
      MpesaReceiptNumber:
        callback.CallbackMetadata?.Item?.find(
          (i) => i.Name === "MpesaReceiptNumber"
        )?.Value || "",
      TransactionDate:
        callback.CallbackMetadata?.Item?.find(
          (i) => i.Name === "TransactionDate"
        )?.Value || "",
      PhoneNumber:
        callback.CallbackMetadata?.Item?.find((i) => i.Name === "PhoneNumber")
          ?.Value || "",
      rawCallback: req.body,
    });

    await newTransaction.save();
    console.log("💾 Saved transaction");

    res.json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (err) {
    console.error("❌ Error saving callback:", err);
    res.status(500).json({ message: "Callback save error" });
  }
});

// 🔹 Fetch Transactions
app.get("/transactions", async (req, res) => {
  try {
    const transactions = await Transaction.find().sort({ _id: -1 });
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ message: "Error fetching transactions" });
  }
});

// 🔹 Root Route
app.get("/", (req, res) => {
  res.send("🚀 M-Pesa + MongoDB API deployed successfully!");
});

// ✅ Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server running in ${MPESA_ENV} mode on port ${PORT}`)
);
