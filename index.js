const express = require("express");
const axios = require("axios");

const app = express();

// ---------- Middleware ----------
app.use(express.json());

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const FLW_WEBHOOK_SECRET_HASH = process.env.FLW_WEBHOOK_SECRET_HASH;

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "Orders";

const APP_BASE_URL = process.env.APP_BASE_URL; 
// example: https://flutterwave-sbhw.onrender.com

const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || "NGN";

// ---------- Validation ----------
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
    console.error("Missing env vars:", missing.join(", "));
  }
}
assertEnv();

// ---------- Airtable Helper ----------
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

// ---------- Flutterwave Helpers ----------
async function createFlutterwavePaymentLink(order) {
  const payload = {
    tx_ref: order.order_id,
    amount: Number(order.amount),
    currency: order.currency || DEFAULT_CURRENCY,
    redirect_url: `${APP_BASE_URL}/success`,
    customer: {
      email: order.email,
      name: order.CustomerName,
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

// ---------- Core Verification Logic ----------
async function verifyAndMarkOrderPaid({
  transactionId,
  txRef,
}) {
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

  // already paid? idempotent safe
  if (fields.status === "paid") {
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
    payment_status_from_gateway: verifiedStatus,
    transaction_id: String(transactionId),
    flw_tx_ref: verifiedTxRef || "",
    paid_amount: verifiedAmount,
    paid_currency: verifiedCurrency || "",
  });

  return {
    ok: true,
    orderId: fields.order_id,
    verified,
  };
}

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.status(200).send("Server is running ✅");
});

app.get("/pay", async (req, res) => {
  try {
    const { order_id } = req.query;

    // 1. order_id missing
    if (!order_id) {
      return res.status(400).send("Order ID is required ❌");
    }

    // 2. format validation
    if (!order_id.startsWith("ORD-")) {
      return res.status(400).send("Invalid Order ID format ❌");
    }

    // 3. search in Airtable
    const orderResult = await getOrderByOrderId(order_id);

    if (!orderResult) {
      return res.status(404).send("Incorrect Order ID / Order not found ❌");
    }

    const { recordId, fields } = orderResult;

    // 4. already paid
    if (
      fields.status === "paid" ||
      fields.status === "Completed"
    ) {
      return res.status(200).send("This order is already paid ✅");
    }

    // 5. required fields check
    const requiredFields = [
      "order_id",
      "CustomerName",
      "email",
      "amount"
    ];

    const missing = requiredFields.filter((f) => !fields[f]);

    if (missing.length) {
      return res
        .status(400)
        .send(`Order data incomplete: ${missing.join(", ")} ❌`);
    }

    // 6. amount validation
    if (Number(fields.amount) <= 0) {
      return res.status(400).send("Invalid payment amount ❌");
    }

    // 7. create payment link
    const { paymentLink } = await createFlutterwavePaymentLink(fields);

    await updateOrderRecord(recordId, {
      payment_link_generated: "yes",
      latest_payment_link: paymentLink,
      status: fields.status || "pending"
    });

    return res.redirect(paymentLink);

  } catch (error) {
    console.error(
      "PAY ROUTE ERROR:",
      error.response?.data || error.message
    );

    return res
      .status(500)
      .send("Unable to initialize payment right now. Please try again later ❌");
  }
});

// 2) User lands here after payment attempt
app.get("/success", async (req, res) => {
  try {
    const { status, transaction_id, tx_ref } = req.query;

    if (!transaction_id || !tx_ref) {
      return res
        .status(400)
        .send("Payment callback missing transaction_id or tx_ref");
    }

    const result = await verifyAndMarkOrderPaid({
      transactionId: transaction_id,
      txRef: tx_ref,
    });

    if (result.ok) {
      return res.status(200).send("Payment verified successfully ✅");
    }

    return res
      .status(400)
      .send(`Payment could not be verified ❌ (${result.reason})`);
  } catch (error) {
    console.error("SUCCESS ROUTE ERROR:", error.response?.data || error.message);
    return res.status(500).send("Payment verification failed ❌");
  }
});

// 3) Flutterwave webhook
app.post("/webhook/flutterwave", async (req, res) => {
  try {
    const signature = req.headers["flutterwave-signature"];

    if (!signature || signature !== FLW_WEBHOOK_SECRET_HASH) {
      return res.status(401).send("Invalid webhook signature");
    }

    const payload = req.body;

    // respond quick-ish pattern
    const event = payload?.event;
    const data = payload?.data;

    if (!data?.id || !data?.tx_ref) {
      return res.status(200).send("Webhook received");
    }

    // process only relevant payment completion events
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

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
