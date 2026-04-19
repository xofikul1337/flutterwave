const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();

// -----------------------------
// ENV
// -----------------------------
const PORT = process.env.PORT || 3000;

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const FLW_WEBHOOK_SECRET_HASH = process.env.FLW_WEBHOOK_SECRET_HASH;

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "Orders";

const APP_BASE_URL = process.env.APP_BASE_URL;
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || "NGN";

// -----------------------------
// Middleware
// -----------------------------
// Normal JSON routes
app.use((req, res, next) => {
  if (req.path === "/webhook/flutterwave") return next();
  express.json()(req, res, next);
});

// Raw body needed for Flutterwave webhook signature validation
app.use("/webhook/flutterwave", express.raw({ type: "*/*" }));

// -----------------------------
// Validation
// -----------------------------
function assertEnv() {
  const required = [
    "FLW_SECRET_KEY",
    "FLW_WEBHOOK_SECRET_HASH",
    "AIRTABLE_API_KEY",
    "AIRTABLE_BASE_ID",
    "APP_BASE_URL",
  ];

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error("Missing ENV vars:", missing.join(", "));
  }
}
assertEnv();

// -----------------------------
// Airtable Helpers
// -----------------------------
const airtableBaseUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
  AIRTABLE_TABLE_NAME
)}`;

const airtableHeaders = {
  Authorization: `Bearer ${AIRTABLE_API_KEY}`,
  "Content-Type": "application/json",
};

async function getOrderByOrderId(orderId) {
  const formula = `{order_id}="${String(orderId).replace(/"/g, '\\"')}"`;
  const url = `${airtableBaseUrl}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

  const res = await axios.get(url, { headers: airtableHeaders });
  const records = res.data.records || [];

  if (!records.length) return null;

  return {
    recordId: records[0].id,
    fields: records[0].fields,
  };
}

async function updateOrderRecord(recordId, fields) {
  const url = `${airtableBaseUrl}/${recordId}`;

  const res = await axios.patch(
    url,
    { fields },
    { headers: airtableHeaders }
  );

  return res.data;
}

// -----------------------------
// Flutterwave Helpers
// -----------------------------
async function createFlutterwavePaymentLink(order) {
  const payload = {
    tx_ref: order.order_id,
    amount: Number(order.amount),
    currency: order.currency || DEFAULT_CURRENCY,
    redirect_url: `${APP_BASE_URL}/success`,
    customer: {
      email: order.email,
      name: order.CustomerName, // ✅ DB অনুযায়ী fix
      phonenumber: order.phone || undefined,
    },
    customizations: {
      title: order.title || "Order Payment",
      description: order.description || "Order Payment",
    },
  };

  const res = await axios.post(
    "https://api.flutterwave.com/v3/payments",
    payload,
    {
      headers: {
        Authorization: `Bearer ${FLW_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  const paymentLink = res.data?.data?.link;

  if (!paymentLink) {
    throw new Error("Flutterwave payment link not found in response");
  }

  return {
    paymentLink,
    raw: res.data,
  };
}

async function verifyFlutterwaveTransaction(transactionId) {
  const res = await axios.get(
    `https://api.flutterwave.com/v3/transactions/${transactionId}/verify`,
    {
      headers: {
        Authorization: `Bearer ${FLW_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return res.data?.data;
}

// -----------------------------
// Webhook Signature Validation
// -----------------------------
function isValidFlutterwaveWebhook(rawBody, signature, secretHash) {
  const hash = crypto
    .createHmac("sha256", secretHash)
    .update(rawBody)
    .digest("base64");

  return hash === signature;
}

// -----------------------------
// Core Verification Logic
// -----------------------------
async function verifyAndMarkOrderPaid({ transactionId, txRef }) {
  if (!transactionId || !txRef) {
    return {
      ok: false,
      reason: "Missing transactionId or txRef",
    };
  }

  const orderResult = await getOrderByOrderId(txRef);

  if (!orderResult) {
    return {
      ok: false,
      reason: "Order not found",
    };
  }

  const { recordId, fields } = orderResult;

  // already paid
  if (String(fields.status).toLowerCase() === "paid") {
    return {
      ok: true,
      alreadyPaid: true,
      orderId: fields.order_id,
    };
  }

  const verified = await verifyFlutterwaveTransaction(transactionId);

  if (!verified) {
    return {
      ok: false,
      reason: "Verification response missing",
    };
  }

  const expectedAmount = Number(fields.amount);
  const expectedCurrency = fields.currency || DEFAULT_CURRENCY;

  const verifiedAmount = Number(verified.amount);
  const verifiedCurrency = verified.currency;
  const verifiedStatus = verified.status;
  const verifiedTxRef = verified.tx_ref;

  const isValid =
    verifiedStatus === "successful" &&
    verifiedTxRef === fields.order_id &&
    verifiedCurrency === expectedCurrency &&
    verifiedAmount >= expectedAmount;

  if (!isValid) {
    await updateOrderRecord(recordId, {
      verification_status: "failed",
      last_verified_transaction_id: String(transactionId),
      payment_status_from_gateway: verifiedStatus || "",
      last_verify_note: "Verification mismatch",
    });

    return {
      ok: false,
      reason: "Verification mismatch",
      verified,
    };
  }

  await updateOrderRecord(recordId, {
    status: "paid",
    verification_status: "verified",
    transaction_id: String(transactionId),
    payment_status_from_gateway: verifiedStatus,
    paid_amount: verifiedAmount,
    paid_currency: verifiedCurrency || "",
    flw_tx_ref: verifiedTxRef || "",
    last_verified_transaction_id: String(transactionId),
    last_verify_note: "Payment verified successfully",
  });

  return {
    ok: true,
    orderId: fields.order_id,
    verified,
  };
}

// -----------------------------
// Routes
// -----------------------------
app.get("/", (req, res) => {
  res.status(200).send("Server is running ✅");
});

// 1) Payment Link Route
app.get("/pay", async (req, res) => {
  try {
    const { order_id } = req.query;

    if (!order_id) {
      return res.status(400).send("<h2>Invalid payment link ❌</h2>");
    }

    const orderResult = await getOrderByOrderId(order_id);

    if (!orderResult) {
      return res.status(404).send("<h2>Invalid payment link ❌</h2>");
    }

    const { recordId, fields } = orderResult;

    if (String(fields.status).toLowerCase() === "paid") {
      return res.status(200).send("<h2>This order is already paid ✅</h2>");
    }

    const requiredFields = ["order_id", "CustomerName", "email", "amount"];
    const missing = requiredFields.filter((f) => !fields[f]);

    if (missing.length) {
      return res
        .status(400)
        .send(`<h2>Order is missing required fields: ${missing.join(", ")}</h2>`);
    }

    const { paymentLink } = await createFlutterwavePaymentLink(fields);

    await updateOrderRecord(recordId, {
      status: fields.status || "pending",
      payment_link_generated: "yes",
      latest_payment_link: paymentLink,
    });

    return res.redirect(paymentLink);
  } catch (error) {
    console.error("PAY ROUTE ERROR:", error.response?.data || error.message);
    return res.status(500).send(`
      <h2>Payment initialization failed ❌</h2>
      <pre>${JSON.stringify(error.response?.data || error.message, null, 2)}</pre>
    `);
  }
});

// 2) Redirect Success Route
app.get("/success", async (req, res) => {
  try {
    const { transaction_id, tx_ref, status } = req.query;

    if (!transaction_id || !tx_ref) {
      return res
        .status(400)
        .send("<h2>Payment callback missing transaction_id or tx_ref ❌</h2>");
    }

    const result = await verifyAndMarkOrderPaid({
      transactionId: transaction_id,
      txRef: tx_ref,
    });

    if (result.ok) {
      return res.status(200).send(`
        <h2>Payment verified successfully ✅</h2>
        <p>Your order has been confirmed.</p>
      `);
    }

    return res.status(400).send(`
      <h2>Payment could not be verified ❌</h2>
      <p>${result.reason}</p>
      <p>Gateway status: ${status || "unknown"}</p>
    `);
  } catch (error) {
    console.error("SUCCESS ROUTE ERROR:", error.response?.data || error.message);
    return res.status(500).send(`
      <h2>Payment verification failed ❌</h2>
      <pre>${JSON.stringify(error.response?.data || error.message, null, 2)}</pre>
    `);
  }
});

// 3) Flutterwave Webhook
app.post("/webhook/flutterwave", async (req, res) => {
  try {
    const signature = req.headers["flutterwave-signature"];
    const rawBody = req.body;

    if (!signature) {
      return res.status(401).send("Missing webhook signature");
    }

    const validSignature = isValidFlutterwaveWebhook(
      rawBody,
      signature,
      FLW_WEBHOOK_SECRET_HASH
    );

    if (!validSignature) {
      return res.status(401).send("Invalid webhook signature");
    }

    const payload = JSON.parse(rawBody.toString("utf8"));
    const event = payload?.event;
    const data = payload?.data;

    if (!data?.id || !data?.tx_ref) {
      return res.status(200).send("Webhook received");
    }

    if (event === "charge.completed" || data?.status === "successful") {
      try {
        await verifyAndMarkOrderPaid({
          transactionId: data.id,
          txRef: data.tx_ref,
        });
      } catch (innerError) {
        console.error(
          "WEBHOOK VERIFY ERROR:",
          innerError.response?.data || innerError.message
        );
      }
    }

    return res.status(200).send("Webhook processed");
  } catch (error) {
    console.error("WEBHOOK ERROR:", error.response?.data || error.message);
    return res.status(500).send("Webhook processing failed");
  }
});

// -----------------------------
// Start
// -----------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
