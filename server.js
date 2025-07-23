import express from 'express';
import cors from 'cors';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import dotenv from 'dotenv';
import axios from 'axios';

// Load environment variables
dotenv.config();

// Initialize Firebase
const firebaseConfig = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECTID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
};

const app = initializeApp({
  credential: cert(firebaseConfig)
});
const db = getFirestore(app);

// Express setup
const server = express();
const PORT = process.env.PORT || 3000;

// Middleware
server.use(cors());
server.use(express.json());

// WATI Configuration
const WATI_BASE_URL = 'https://live-mt-server.wati.io/361402/api/v1';
const WATI_API_TOKEN = process.env.WATI_API_TOKEN;

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
      case 'templateMessageSent_v2':
        result = await handleTemplateMessage(db, event);
        break;
      case 'sessionMessageSent_v2':
        result = await handleSessionMessage(db, event);
        break;
      case 'sentMessageDELIVERED_v2':
        result = await handleDeliveryStatus(db, event);
        break;
      case 'sentMessageREAD':
      case 'sentMessageREAD_v2':
        result = await handleReadStatus(db, event);
        break;
      default:
        console.log('Unhandled event type:', event.eventType);
        result = { status: 'unhandled' };
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

// Event handlers
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
    status: event.statusString.toLowerCase(),
    direction: 'outgoing',
    rawData: event
  };

  await db.collection('whatsapp_messages').doc(event.id).set(messageData);
  return { status: 'template_processed' };
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

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});