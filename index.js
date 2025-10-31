// server.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ----- MongoDB -----
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// ----- Transaction schema -----
const transactionSchema = new mongoose.Schema({
  MerchantRequestID: String,
  CheckoutRequestID: String,
  ResultCode: Number,
  ResultDesc: String,
  Amount: Number,
  MpesaReceiptNumber: String,
  TransactionDate: String,
  PhoneNumber: String,
  receiverNumber: String,
  rawCallback: Object,
  createdAt: { type: Date, default: Date.now },
});
const Transaction = mongoose.model("Transaction", transactionSchema);

// ----- Env variables -----
const {
  CONSUMER_KEY,
  CONSUMER_SECRET,
  SHORTCODE,
  PASSKEY,
  CALLBACK_URL,
  MPESA_ENV = "sandbox",
  PORT = 3000,
} = process.env;

// ----- Base URL -----
const baseURL =
  MPESA_ENV === "live"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

// ----- Helpers -----
function formatTimestamp() {
  // returns YYYYMMDDhhmmss (M-Pesa required)
  const d = new Date();
  const YYYY = d.getFullYear();
  const MM = `${d.getMonth() + 1}`.padStart(2, "0");
  const DD = `${d.getDate()}`.padStart(2, "0");
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mm = `${d.getMinutes()}`.padStart(2, "0");
  const ss = `${d.getSeconds()}`.padStart(2, "0");
  return `${YYYY}${MM}${DD}${hh}${mm}${ss}`;
}

function makePassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

function normalizePhone(input) {
  if (!input) return "";
  let s = input.toString().trim();
  if (s.startsWith("07")) return "254" + s.substring(1);
  if (s.startsWith("+254")) return s.replace("+", "");
  if (s.startsWith("254")) return s;
  // trying to salvage: if 9 digits (7XXXXXXXX) maybe add 254
  if (/^\d{9}$/.test(s)) return "254" + s;
  return s;
}

// ----- Token cache (simple) -----
let tokenCache = { token: null, expiresAt: 0 };
async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 5000) {
    return tokenCache.token;
  }

  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString(
    "base64"
  );
  const url = `${baseURL}/oauth/v1/generate?grant_type=client_credentials`;
  const { data } = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}` },
  });
  tokenCache.token = data.access_token;
  // expires_in (seconds)
  tokenCache.expiresAt = now + (data.expires_in || 3600) * 1000;
  return tokenCache.token;
}

// ----- Routes -----

// Root
app.get("/", (req, res) =>
  res.send("🚀 M-Pesa + MongoDB API deployed successfully!")
);

// TOKEN (optional)
app.get("/token", async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ access_token: token });
  } catch (err) {
    console.error("token err:", err.response?.data || err.message);
    res
      .status(500)
      .json({
        message: "Failed to get token",
        error: err.response?.data || err.message,
      });
  }
});

// STK Push - expects { phone, amount, receiver } - receiver optional (defaults to paying phone)
app.post("/stkpush", async (req, res) => {
  try {
    let { phone, amount, receiver } = req.body;
    if (!phone || !amount)
      return res.status(400).json({ message: "phone and amount are required" });

    // normalize and validate
    const partyA = normalizePhone(phone);
    const receiverNormalized = receiver ? normalizePhone(receiver) : partyA;

    if (!/^2547\d{8}$/.test(partyA)) {
      return res
        .status(400)
        .json({
          message:
            "Invalid paying phone format. Use 07XXXXXXXX or +2547XXXXXXXX or 2547XXXXXXXX",
        });
    }

    // get token
    const accessToken = await getAccessToken();

    // prepare values
    const timestamp = formatTimestamp();
    const password = makePassword(SHORTCODE, PASSKEY, timestamp);

    const payload = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline", // CustomerBuyGoodsOnline also OK; choose per your shortcode
      Amount: amount,
      PartyA: partyA, // paying number
      PartyB: SHORTCODE, // typically your shortcode
      PhoneNumber: partyA,
      CallBackURL: CALLBACK_URL, // must be https and reachable
      AccountReference: `RichTech-${receiverNormalized}`, // include receiver to reference
      TransactionDesc: `Bundle purchase for ${receiverNormalized}`,
    };

    // call Safaricom
    const url = `${baseURL}/mpesa/stkpush/v1/processrequest`;
    const { data: stkResponse } = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000,
    });

    // respond with Safaricom response + save basic request record
    res.json({ success: true, payload: stkResponse });
  } catch (error) {
    console.error("STK Push error:", error.response?.data || error.message);
    res
      .status(500)
      .json({
        message: "STK Push failed",
        error: error.response?.data || error.message,
      });
  }
});

// Callback route - Safaricom will POST here
app.post("/callbackurl", async (req, res) => {
  try {
    // Safaricom posts a Body.stkCallback
    const body = req.body || {};
    console.log("Received callback:", JSON.stringify(body, null, 2));

    // try to access stkCallback
    const cb = body.Body?.stkCallback || body.Body?.STKCallback || null;
    if (!cb) {
      console.warn("No stkCallback found in body");
      return res.status(400).json({ message: "No callback body found" });
    }

    const metaItems = cb.CallbackMetadata?.Item || [];
    const getVal = (name) =>
      metaItems.find((i) => i.Name === name)?.Value || null;

    const newTransaction = new Transaction({
      MerchantRequestID: cb.MerchantRequestID,
      CheckoutRequestID: cb.CheckoutRequestID,
      ResultCode: cb.ResultCode,
      ResultDesc: cb.ResultDesc,
      Amount: getVal("Amount") || 0,
      MpesaReceiptNumber: getVal("MpesaReceiptNumber") || "",
      TransactionDate: getVal("TransactionDate") || "",
      PhoneNumber: getVal("PhoneNumber") || "",
      rawCallback: body,
    });

    await newTransaction.save();
    console.log("💾 Saved transaction:", newTransaction._id);

    // Safaricom expects a JSON response with ResultCode 0 for success
    res.json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (err) {
    console.error("Error saving callback:", err);
    res.status(500).json({ message: "Callback save error" });
  }
});

// List transactions
app.get("/transactions", async (req, res) => {
  try {
    const transactions = await Transaction.find()
      .sort({ createdAt: -1 })
      .limit(100);
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ message: "Error fetching transactions" });
  }
});

// Start
app.listen(PORT, () =>
  console.log(`🚀 Server running in ${MPESA_ENV} mode on port ${PORT}`)
);
