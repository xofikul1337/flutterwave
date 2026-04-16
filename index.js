const express = require("express");
const axios = require("axios");

const app = express();

// ENV থেকে key নাও (secure)
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;

app.get("/", async (req, res) => {
  try {
    const { name, email, amount, description } = req.query;

    // Basic validation
    if (!name || !email || !amount) {
      return res.status(400).send("Missing required parameters");
    }

    const tx_ref = "order_" + Date.now();

    const response = await axios.post(
      "https://api.flutterwave.com/v3/payments",
      {
        tx_ref,
        amount: Number(amount),
        currency: "NGN", // চাইলে BDT বা NGN change করতে পারো
        redirect_url: "https://your-site.com/success",
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
          Authorization: `Bearer ${FLW_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const paymentLink = response.data.data.link;

    // 🔥 Auto Redirect
    return res.redirect(paymentLink);

  } catch (error) {
    console.error(error.response?.data || error.message);
    return res.status(500).send("Payment initialization failed");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
