import express from 'express';
import { createServer } from 'node:http';
import cors from 'cors';
import { Timestamp } from 'firebase-admin/firestore';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import dotenv from 'dotenv';
import axios from 'axios';
import { URL } from 'url';
import { parse } from 'querystring';

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

const supportedMediaTypes = ['image', 'audio', 'video', 'voice', 'document', 'sticker'];


// Add this helper function (can be placed with other utility functions)
async function getAttachmentUrl(filename, mediaType) {
    try {
        const response = await axios.get(
            `${WATI_BASE_URL}/getAttachmentUrl`,
            {
                params: { filename },
                headers: {
                    Authorization: `Bearer ${WATI_API_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data.attachment_url;
    } catch (error) {
        console.error('Error fetching attachment URL:', error);
        return null;
    }
}


async function handleMediaMessage(db, event) {
    const msgType = event.type;
    const dataObj = event;
    
    if (!supportedMediaTypes.includes(msgType)) {
        await db.collection('webhook_responses').add({
            response: `⚠️ Unhandled type: ${msgType}`,
            rawData: event,
            timestamp: Timestamp.now()
        });
        return { status: 'unhandled_media_type', type: msgType };
    }

    const dataUrl = dataObj.data || '';
    let filename;

    try {
        const parsedUrl = new URL(dataUrl);
        const queryParams = parse(parsedUrl.search.slice(1));
        filename = queryParams.fileName || parsedUrl.pathname.split('/').pop();
    } catch (e) {
        filename = dataUrl.split('/').pop() || `media_${Date.now()}`;
    }

    let caption = '';
    if (dataObj[msgType]?.caption) {
        caption = dataObj[msgType].caption;
    } else if (dataObj.caption) {
        caption = dataObj.caption;
    }

    const attachmentData = {
        caption,
        sha256: dataUrl,
        attachment_id: filename,
        type: msgType,
        whatsapp_message_id: event.id || null,
        timestamp: Timestamp.now(),
        attachment_url: dataUrl // Use the original URL directly
    };

    await db.collection('webhook_responses').add({
        response: `Attachment handled: ${JSON.stringify(attachmentData)}`,
        timestamp: Timestamp.now()
    });

    try {
        const attachmentRef = await db.collection('whatsapp_attachments').add(attachmentData);
        console.log(`Attachment saved with ID: ${attachmentRef.id}`);
        return { 
            status: 'media_processed',
            attachmentId: attachmentRef.id,
            type: msgType
        };
    } catch (error) {
        console.error('Attachment insert failed:', error);
        return { 
            status: 'media_insert_failed',
            error: error.message,
            type: msgType
        };
    }
}

// Event Handlers
async function handleMessage(db, event) {
    const messageData = {
        id: event.id,
        waId: event.waId,
        text: event.text,
        type: event.type,
        timestamp: event.timestamp ? Timestamp.fromMillis(parseInt(event.timestamp) * 1000) : Timestamp.now(),
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
        timestamp: event.created ? Timestamp.fromMillis(new Date(event.created).getTime()) : Timestamp.now(),
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
        timestamp: event.timestamp ? Timestamp.fromMillis(new Date(event.timestamp).getTime()) : Timestamp.now(),
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
        deliveredAt: Timestamp.fromMillis(parseInt(event.timestamp) * 1000),
        rawDeliveryData: event
    });
    return { status: 'delivery_status_updated' };
}

async function handleReadStatus(db, event) {
    // Update the existing message with read status
    const messageRef = db.collection('whatsapp_messages').doc(event.id);
    await messageRef.update({
        status: 'read',
        readAt: Timestamp.fromMillis(parseInt(event.timestamp) * 1000),
        rawReadData: event
    });
    return { status: 'read_status_updated' };
}

// Remove the initiateChatWithTemplate function and add this endpoint instead:
server.post('/api/wati/send-template', async (req, res) => {
    try {
        const { phone, templateName = "missed_appointment" } = req.body;

        // Validate required fields
        if (!phone) {
            return res.status(400).json({ error: "Phone number is required" });
        }

        // Send template message via WATI API
        const response = await axios.post(
            `${WATI_BASE_URL}/sendTemplateMessage?whatsappNumber=${phone}`,
            {
                template_name: templateName,
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

        // Create a record in Firestore
        const messageData = {
            waId: phone,
            direction: "outgoing",
            status: "sent",
            type: "template",
            templateName: templateName,
            timestamp: Timestamp.now(),
            rawData: {
                eventType: "templateMessageSent",
                templateName: templateName,
                watiResponse: response.data
            }
        };

        await db.collection('whatsapp_messages').add(messageData);

        return res.status(200).json({
            success: true,
            message: "Template message sent successfully",
            templateUsed: templateName,
            watiResponse: response.data
        });

    } catch (error) {
        console.error('Error sending template:', error);

        const errorResponse = {
            error: "Failed to send template message",
            details: error.message,
            templateName: req.body.templateName || "missed_appointment"
        };

        if (error.response) {
            errorResponse.watiError = {
                status: error.response.status,
                data: error.response.data
            };
        }

        return res.status(500).json(errorResponse);
    }
});
// Webhook endpoint
server.post('/webhook', async (req, res) => {
    try {
        console.log('Received WATI webhook:', req.body);
        const event = req.body;

        // Store raw event in Firestore
        const eventRef = await db.collection('wati_webhook_events').add({
            ...event,
            receivedAt: Timestamp.now(),
            processed: false
        });

        // Process event type
        let result;
        switch (event.eventType) {
            case 'message':
                if (supportedMediaTypes.includes(event.type)) {
                    result = await handleMediaMessage(db, event);
                } else {
                    result = await handleMessage(db, event);
                }
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

        if (!waNumber) {
            return res.status(400).json({ error: "WhatsApp number is required" });
        }

        try {
            const query = db.collection('whatsapp_messages')
                .where('waId', '==', waNumber)
                .orderBy('timestamp', 'asc')
                .limit(50);

            const snapshot = await query.get();

            if (snapshot.empty) {
                return res.status(200).json([]);
            }


            const messages = snapshot.docs.map(doc => {
                const data = doc.data();

                // Safely handle timestamp conversion
                let timestampMillis;
                if (data.timestamp?.toMillis) {
                    timestampMillis = data.timestamp.toMillis();
                } else if (typeof data.timestamp === 'string') {
                    // Handle both Unix timestamp strings and ISO strings
                    timestampMillis = isNaN(data.timestamp)
                        ? new Date(data.timestamp).getTime()
                        : parseInt(data.timestamp) * 1000;
                } else if (typeof data.timestamp === 'number') {
                    // Assume milliseconds if number is large, seconds if small
                    timestampMillis = data.timestamp > 9999999999
                        ? data.timestamp
                        : data.timestamp * 1000;
                } else {
                    // Fallback to current time if timestamp is invalid
                    timestampMillis = Date.now();
                }

                // Safely format date
                let formattedDate;
                try {
                    formattedDate = new Date(timestampMillis).toISOString();
                } catch (e) {
                    formattedDate = new Date().toISOString();
                }

                return {
                    id: doc.id,
                    text: data.text,
                    direction: data.direction,
                    status: data.status,
                    timestamp: timestampMillis,
                    formattedDate: formattedDate,
                    waId: data.waId
                };
            });

            // Final sort to ensure proper ordering
            messages.sort((a, b) => a.timestamp - b.timestamp);

            return res.status(200).json(messages);

        } catch (queryError) {
            if (queryError.code === 9) { // FAILED_PRECONDITION
                console.warn('Using fallback query (index may be building)');

                const snapshot = await db.collection('whatsapp_messages')
                    .where('waId', '==', waNumber)
                    .limit(50)
                    .get();

                const messages = snapshot.docs.map(doc => {
                    const data = doc.data();

                    // Same safe timestamp handling as above
                    let timestampMillis;
                    if (data.timestamp?.toMillis) {
                        timestampMillis = data.timestamp.toMillis();
                    } else if (typeof data.timestamp === 'string') {
                        timestampMillis = isNaN(data.timestamp)
                            ? new Date(data.timestamp).getTime()
                            : parseInt(data.timestamp) * 1000;
                    } else if (typeof data.timestamp === 'number') {
                        timestampMillis = data.timestamp > 9999999999
                            ? data.timestamp
                            : data.timestamp * 1000;
                    } else {
                        timestampMillis = Date.now();
                    }

                    let formattedDate;
                    try {
                        formattedDate = new Date(timestampMillis).toISOString();
                    } catch (e) {
                        formattedDate = new Date().toISOString();
                    }

                    return {
                        id: doc.id,
                        text: data.text,
                        direction: data.direction,
                        status: data.status,
                        timestamp: timestampMillis,
                        formattedDate: formattedDate,
                        waId: data.waId
                    };
                });

                messages.sort((a, b) => a.timestamp - b.timestamp);
                return res.status(200).json(messages);
            }
            throw queryError;
        }
    } catch (error) {
        console.error('Fetch messages error:', error);
        res.status(500).json({
            error: 'Failed to fetch messages',
            ...(process.env.NODE_ENV === 'development' && {
                details: error.message
            })
        });
    }
});

// API endpoint to send messages
server.post('/api/wati/send-message', async (req, res) => {
    try {
        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).json({ error: "Phone and message are required" });
        }

        // 1. First send to WATI API
        const watiResponse = await axios.post(
            `https://live-mt-server.wati.io/361402/api/v1/sendSessionMessage/${phone}?messageText=${encodeURIComponent(message)}`,
            null, // No body needed for this request
            {
                headers: {
                    "Authorization": `Bearer ${process.env.WATI_API_TOKEN}`,
                    "Content-Type": "application/json"
                }
            }
        );

        // 2. Save to Firestore
        const messageData = {
            text: message,
            waId: phone,
            direction: "outgoing",
            status: "sent",
            timestamp: Timestamp.now(), // Use Firestore Timestamp
            rawData: {
                eventType: "sessionMessageSent",
                whatsappResponse: watiResponse.data
            }
        };

        await db.collection('whatsapp_messages').add(messageData);

        res.status(200).json({
            success: true,
            messageId: watiResponse.data.id
        });

    } catch (error) {
        console.error("Error sending message:", error);

        // Determine if the error is from WATI or our system
        const errorMessage = error.response?.data?.message ||
            error.message ||
            "Failed to send message";

        res.status(500).json({
            error: errorMessage,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
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