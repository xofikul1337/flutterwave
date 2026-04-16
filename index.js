const express = require("express");
const axios = require("axios");

const app = express();

// Health check (IMPORTANT - Not Found fix)
app.get("/", (req, res) => {
  res.send("Server is running ✅");
});

// Payment route
app.get("/pay", async (req, res) => {
  try {
    const { name, email, amount, description } = req.query;

    // Validation
    if (!name || !email || !amount) {
      return res.status(400).send("Missing parameters");
    }

    const tx_ref = "order_" + Date.now();

    const response = await axios.post(
      "https://api.flutterwave.com/v3/payments",
      {
        tx_ref: tx_ref,
        amount: Number(amount),
        currency: "NGR",
        redirect_url: "https://example.com/success",
        customer: {
          email: email,
          name: name,
        },
        customizations: {
          title: "Order Payment",
          description: description || "Order Payment",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const paymentLink = response.data.data.link;

    // 🔥 Redirect to Flutterwave payment page
    return res.redirect(paymentLink);

  } catch (error) {
    console.error(error.response?.data || error.message);
    return res.status(500).send("Payment failed ❌");
  }
});

// MUST for Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
