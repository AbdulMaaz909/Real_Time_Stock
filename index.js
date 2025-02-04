
// Environment setup
require('dotenv').config();
const express = require("express");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const cors = require("cors");
const bodyParser = require("body-parser");
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

// Environment variables
const SECRET_KEY = process.env.JWT_SECRET_KEY;
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

// Initialize Express
const app = express();

// Rate limiting setup
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});

// Middleware setup
app.use(apiLimiter);
app.use(cors());
app.use(bodyParser.json());

// Firebase initialization
admin.initializeApp({
    credential: admin.credential.applicationDefault()
});

// Firestore initialization
const db = admin.firestore();

// JWT Middleware
const verifyToken = (req, res, next) => {
    const token = req.headers["authorization"];
    if (!token) return res.status(403).send("Token required");
    jwt.verify(token, SECRET_KEY, (err, decoded) => {
        if (err) return res.status(401).send("Invalid token");
        req.user = decoded;
        next();
    });
};

// Enhanced signup with validation
app.post("/signup", [
    body('email').isEmail(),
    body('password').isLength({ min: 6 }),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        
        const { email, password } = req.body;
        const userRecord = await admin.auth().createUser({ email, password });
        
        // Create initial portfolio document
        await db.collection('users').doc(userRecord.uid).set({
            email,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            role: 'user'
        });
        
        res.status(201).send({ uid: userRecord.uid, message: "User registered" });
    } catch (error) {
        res.status(400).send(error.message);
    }
});

// User Login
app.post("/login", async (req, res) => {
    try {
        const { email } = req.body;
        const user = await admin.auth().getUserByEmail(email);
        const token = jwt.sign({ uid: user.uid }, SECRET_KEY, { expiresIn: "1h" });
        res.status(200).send({ token });
    } catch (error) {
        res.status(400).send(error.message);
    }
});

// Portfolio routes
app.post("/portfolio/add", verifyToken, async (req, res) => {
    try {
        const { symbol, quantity, purchasePrice } = req.body;
        await db.collection("portfolios").add({
            uid: req.user.uid,
            symbol,
            quantity,
            purchasePrice
        });
        res.status(201).send("Stock added");
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// Enhanced portfolio retrieval with real-time values
app.get("/portfolio", verifyToken, async (req, res) => {
    try {
        const portfolio = await db.collection("portfolios")
            .where("uid", "==", req.user.uid)
            .get();
        
        const stocks = await Promise.all(portfolio.docs.map(async doc => {
            const stockData = doc.data();
            try {
                const response = await axios.get(
                    `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${stockData.symbol}&apikey=${ALPHA_VANTAGE_API_KEY}`
                );
                
                const currentPrice = parseFloat(response.data['Global Quote']['05. price']);
                const totalValue = currentPrice * stockData.quantity;
                const profitLoss = (currentPrice - stockData.purchasePrice) * stockData.quantity;
                
                return {
                    id: doc.id,
                    ...stockData,
                    currentPrice,
                    totalValue,
                    profitLoss
                };
            } catch (error) {
                return {
                    id: doc.id,
                    ...stockData,
                    error: 'Failed to fetch current price'
                };
            }
        }));
        
        const portfolioSummary = {
            stocks,
            totalValue: stocks.reduce((sum, stock) => sum + (stock.totalValue || 0), 0),
            totalProfitLoss: stocks.reduce((sum, stock) => sum + (stock.profitLoss || 0), 0)
        };
        
        res.status(200).send(portfolioSummary);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

app.put("/portfolio/:id", verifyToken, async (req, res) => {
    try {
        await db.collection("portfolios").doc(req.params.id).update(req.body);
        res.status(200).send("Stock updated");
    } catch (error) {
        res.status(500).send(error.message);
    }
});

app.delete("/portfolio/:id", verifyToken, async (req, res) => {
    try {
        await db.collection("portfolios").doc(req.params.id).delete();
        res.status(200).send("Stock removed");
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// Enhanced stock price fetching
app.get("/stocks/live", verifyToken, async (req, res) => {
    try {
        const { symbol } = req.query;
        if (!symbol) {
            return res.status(400).send("Symbol is required");
        }
        
        const response = await axios.get(
            `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${ALPHA_VANTAGE_API_KEY}`
        );
        
        if (!response.data['Global Quote']) {
            return res.status(404).send("Stock not found");
        }
        
        const stockData = {
            symbol,
            price: response.data['Global Quote']['05. price'],
            change: response.data['Global Quote']['09. change'],
            changePercent: response.data['Global Quote']['10. change percent'],
            volume: response.data['Global Quote']['06. volume'],
            lastUpdated: response.data['Global Quote']['07. latest trading day']
        };
        
        res.status(200).send(stockData);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// Admin routes
app.get("/admin/user-portfolios", verifyToken, async (req, res) => {
    if (!req.user.admin) return res.status(403).send("Admin access only");
    try {
        const portfolios = await db.collection("portfolios").get();
        const data = portfolios.docs.map(doc => doc.data());
        res.status(200).send(data);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// Server startup
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));