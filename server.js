import express from 'express';
import { createServer } from 'node:http';
import cors from 'cors';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import dotenv from 'dotenv';
import axios from 'axios';

// Load environment variables
dotenv.config();

// Express setup
const server = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server
const httpServer = createServer(server);

// Middleware
server.use(cors());
server.use(express.json());

// Firebase initialization
console.log("🔥 Initializing Firebase...");
console.log("🔥 FIREBASE_PROJECT_ID:", process.env.FIREBASE_PROJECT_ID);
console.log("🔥 FIREBASE_CLIENT_EMAIL:", process.env.FIREBASE_CLIENT_EMAIL);
console.log("🔥 FIREBASE_PRIVATE_KEY (partial):", process.env.FIREBASE_PRIVATE_KEY?.slice(0, 30), "...");

if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
  console.error("❌ Missing Firebase environment variables.");
  process.exit(1);
}

let db;
try {
  const firebaseApp = initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
  console.log("✅ Firebase initialized successfully.");
  
  db = getFirestore(firebaseApp);
  server.locals.db = db; // Make db available in routes
} catch (error) {
  console.error("❌ Firebase initialization error:", error);
  process.exit(1);
}

// WATI Configuration
const WATI_BASE_URL = 'https://live-mt-server.wati.io/361402/api/v1';
const WATI_API_TOKEN = process.env.WATI_API_TOKEN;

// Event Handlers
async function handleMessage(db, event) {
  const messageData = {
    id: event.id,
    waId: event.waId,
    text: event.text,
    type: event.type,
    timestamp: event.timestamp,
    status: 'received',
    direction: 'incoming',
    rawData: event
  };

  await db.collection('whatsapp_messages').doc(event.id).set(messageData);
  return { status: 'message_processed' };
}

async function handleTemplateMessage(db, event) {
  const messageData = {
    id: event.id,
    waId: event.waId,
    text: event.text,
    type: 'template',
    templateName: event.templateName,
    timestamp: new Date(event.created).getTime(),
    status: event.statusString?.toLowerCase() || 'sent',
    direction: 'outgoing',
    rawData: event
  };

  await db.collection('whatsapp_messages').doc(event.id).set(messageData);
  return { status: 'template_processed' };
}

async function handleSessionMessage(db, event) {
  const messageData = {
    id: event.id,
    waId: event.waId,
    text: event.text,
    type: 'session',
    timestamp: new Date(event.timestamp).getTime(),
    status: event.statusString?.toLowerCase() || 'sent',
    direction: 'outgoing',
    rawData: event
  };

  await db.collection('whatsapp_messages').doc(event.id).set(messageData);
  return { status: 'session_message_processed' };
}

async function handleDeliveryStatus(db, event) {
  // Update the existing message with delivery status
  const messageRef = db.collection('whatsapp_messages').doc(event.id);
  await messageRef.update({
    status: 'delivered',
    deliveredAt: new Date(parseInt(event.timestamp) * 1000),
    rawDeliveryData: event
  });
  return { status: 'delivery_status_updated' };
}

async function handleReadStatus(db, event) {
  // Update the existing message with read status
  const messageRef = db.collection('whatsapp_messages').doc(event.id);
  await messageRef.update({
    status: 'read',
    readAt: new Date(parseInt(event.timestamp) * 1000),
    rawReadData: event
  });
  return { status: 'read_status_updated' };
}

async function initiateChatWithTemplate(waNumber) {
  try {
    const response = await axios.post(
      `${WATI_BASE_URL}/sendTemplateMessage?whatsappNumber=${waNumber}`,
      {
        template_name: "missed_appointment",
        broadcast_name: `init_${Date.now()}`,
        parameters: [{ name: "name", value: "Customer" }],
        channel_number: "27772538155"
      },
      {
        headers: {
          Authorization: `Bearer ${WATI_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return true;
  } catch (error) {
    console.error('Initiation error:', error.response?.data || error.message);
    return false;
  }
}

// Webhook endpoint
server.post('/webhook', async (req, res) => {
  try {
    console.log('Received WATI webhook:', req.body);
    const event = req.body;

    // Store raw event in Firestore
    const eventRef = await db.collection('wati_webhook_events').add({
      ...event,
      receivedAt: new Date(),
      processed: false
    });

    // Process event type
    let result;
    switch (event.eventType) {
      case 'message':
        result = await handleMessage(db, event);
        break;
      case 'templateMessageSent':
      case 'templateMessageSent_v2':
        result = await handleTemplateMessage(db, event);
        break;
      case 'sessionMessageSent':
      case 'sessionMessageSent_v2':
        result = await handleSessionMessage(db, event);
        break;
      case 'sentMessageDELIVERED':
      case 'sentMessageDELIVERED_v2':
        result = await handleDeliveryStatus(db, event);
        break;
      case 'sentMessageREAD':
      case 'sentMessageREAD_v2':
        result = await handleReadStatus(db, event);
        break;
      default:
        console.log('Unhandled event type:', event.eventType);
        result = { status: 'unhandled', eventType: event.eventType };
    }

    // Update event as processed
    await eventRef.update({
      processed: true,
      processingResult: result
    });

    res.status(200).json({ success: true, eventId: eventRef.id });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint to get messages
server.get('/api/messages/:waNumber', async (req, res) => {
  try {
    const { waNumber } = req.params;
    let query = db.collection('whatsapp_messages').orderBy('timestamp', 'desc').limit(50);

    if (waNumber) {
      query = query.where('waId', '==', waNumber);
      
      // Check if conversation exists
      const snapshot = await query.get();
      if (snapshot.empty) {
        const initiated = await initiateChatWithTemplate(waNumber);
        return res.status(202).json({
          status: initiated ? 'initiating_chat' : 'initiation_failed',
          message: initiated 
            ? 'New conversation started with template' 
            : 'Failed to start conversation'
        });
      }
    }

    const snapshot = await query.get();
    const messages = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(messages);
  } catch (error) {
    console.error('Fetch messages error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Start the server
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM signal received: closing HTTP server");
  httpServer.close(() => {
    console.log("HTTP server closed");
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT signal received: closing HTTP server");
  httpServer.close(() => {
    console.log("HTTP server closed");
  });
});