import { serve } from "https://deno.land/std@0.190.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { create as createJWT } from "https://deno.land/x/djwt@v2.8/mod.ts"

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ""
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ""

// Try multiple secret names for compatibility
const FIREBASE_SERVICE_ACCOUNT = JSON.parse(
    Deno.env.get('FIREBASE_SERVICE_ACCOUNT') ||
    Deno.env.get('FIREBASE_SERVICE_ACCOUNT2') ||
    Deno.env.get('FCM_SERVICE_ACCOUNT') ||
    "{}"
)

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

console.log("Push Notification Function Initialized")
console.log("Firebase project:", FIREBASE_SERVICE_ACCOUNT.project_id || 'NOT SET')

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const payload = await req.json()
        console.log('Notification Payload:', payload)

        const { record, old_record, type } = payload

        if (!record) {
            return new Response(JSON.stringify({ message: 'No record found' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200
            })
        }

        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        const accessToken = await getAccessToken(FIREBASE_SERVICE_ACCOUNT)

        // Determine if the payload is an order_item or an order
        const isOrderItem = record.product_id !== undefined && record.order_id !== undefined;

        // --- NEW ORDER (INSERT) OR UPDATED ORDER WITH MORE ITEMS -> Notify Admin ---
        const isNewOrder = !isOrderItem && (!type || type === 'INSERT');
        const isOrderUpdatedWithMoreItems = !isOrderItem && (type === 'UPDATE' && old_record && record.total_amount > old_record.total_amount);
        const isNewOrderItem = isOrderItem && (!type || type === 'INSERT');

        if (isNewOrder || isOrderUpdatedWithMoreItems || isNewOrderItem) {
            let titlePrefix = 'تحديث الطلب!';
            let bodyPrefix = 'تحديث بخصوص الطلب';
            let notificationTitle = '';
            let notificationBody = '';
            let orderIdForApp = '';

            if (isNewOrderItem) {
                // Fetch order details for customer name
                const { data: orderData } = await supabase
                    .from('orders')
                    .select('customer_name')
                    .eq('id', record.order_id)
                    .single();

                // Fetch product details for product name
                const { data: productData } = await supabase
                    .from('products')
                    .select('name')
                    .eq('id', record.product_id)
                    .single();

                const productName = productData?.name || 'منتج جديد';
                const customerName = orderData?.customer_name || 'عميل';

                notificationTitle = '📦 منتج إضافي للطلب!';
                notificationBody = `قام ${customerName} بإضافة: ${productName} (الكمية: ${record.quantity}) إلى طلبه`;
                orderIdForApp = record.order_id;
            } else {
                titlePrefix = isNewOrder ? 'طلب جديد!' : 'تعديل على الطلب!';
                bodyPrefix = isNewOrder ? 'طلب جديد من' : 'تم إضافة منتجات لطلب';
                notificationTitle = `${titlePrefix} #${(record.id || '').slice(0, 8)}`;
                notificationBody = `${bodyPrefix} ${record.customer_name || 'عميل'}، المجموع الجديد: ${record.total_amount || 0}`;
                orderIdForApp = record.id;
            }

            console.log(`${isNewOrderItem ? 'New item added' : (isNewOrder ? 'New order created' : 'Order updated')}, notifying admins`)

            const { data: admins } = await supabase
                .from('profiles')
                .select('user_id')
                .eq('role', 'admin')
                .eq('is_clocked_in', true)

            const adminIds = admins?.map(a => a.user_id) || []

            if (adminIds.length === 0) {
                return new Response(JSON.stringify({ message: 'No admins clocked in' }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    status: 200
                })
            }

            const { data: tokens } = await supabase
                .from('user_fcm_tokens')
                .select('token')
                .in('user_id', adminIds)

            const fcmTokens = [...new Set(tokens?.map(t => t.token) || [])]

            if (fcmTokens.length === 0) {
                return new Response(JSON.stringify({ message: 'No admin tokens found' }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    status: 200
                })
            }

            const results = await Promise.all(fcmTokens.map(async (token) => {
                const notificationPayload = {
                    title: notificationTitle,
                    body: notificationBody,
                    data: {
                        type: isNewOrderItem ? 'order_item_added' : (isNewOrder ? 'new_order' : 'order_updated'),
                        order_id: orderIdForApp || '',
                        click_action: 'FLUTTER_NOTIFICATION_CLICK',
                    }
                }
                return sendFCM(accessToken, FIREBASE_SERVICE_ACCOUNT.project_id, token, notificationPayload)
            }))

            return new Response(JSON.stringify({ success: true, type: 'admin_notification', sent_to: fcmTokens.length, results }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200
            })
        }

        return new Response(JSON.stringify({ message: 'Ignored: Not a new order' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200
        })

    } catch (error) {
        console.error('Error in push-notification function:', error)
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500
        })
    }
})

async function sendFCM(accessToken: string, projectId: string, token: string, payload: { title: string, body: string, data: any }) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            message: {
                token: token,
                notification: {
                    title: payload.title,
                    body: payload.body,
                },
                data: {
                    ...payload.data,
                    title: payload.title,
                    body: payload.body,
                },
                android: {
                    priority: "HIGH",
                    collapse_key: payload.data?.order_id || Date.now().toString(),
                    notification: {
                        title: payload.title,
                        body: payload.body,
                        sound: "notification_sound",
                        channel_id: "orders_channel",
                        icon: "ic_notification",
                        click_action: "FCM_PLUGIN_ACTIVITY",
                        default_vibrate_timings: true,
                        default_light_settings: true,
                        visibility: "PUBLIC",
                        tag: payload.data?.order_id || Date.now().toString(),
                    }
                },
                apns: {
                    payload: {
                        aps: {
                            sound: "notification_sound.mp3",
                            badge: 1,
                            "content-available": 1,
                        }
                    }
                }
            }
        })
    })
    const result = await res.json()
    console.log('FCM send result:', JSON.stringify(result))
    return result
}

async function getAccessToken(serviceAccount: any) {
    const jwt = await createJWT(
        { alg: "RS256", typ: "JWT" },
        {
            iss: serviceAccount.client_email,
            sub: serviceAccount.client_email,
            aud: "https://oauth2.googleapis.com/token",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
            scope: "https://www.googleapis.com/auth/cloud-platform",
        },
        await importKey(serviceAccount.private_key)
    )

    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: jwt,
        }),
    })

    const data = await res.json()
    if (!data.access_token) {
        console.error('Failed to get access token:', JSON.stringify(data))
        throw new Error('Failed to get Firebase access token')
    }
    return data.access_token
}

async function importKey(pem: string) {
    const pemContents = pem
        .replace("-----BEGIN PRIVATE KEY-----", "")
        .replace("-----END PRIVATE KEY-----", "")
        .replace(/\\n/g, "")
        .replace(/\n/g, "")
        .replace(/\r/g, "")
        .replace(/\s/g, "")
        .trim()

    const binaryDerString = atob(pemContents)
    const binaryDer = new Uint8Array(binaryDerString.length)
    for (let i = 0; i < binaryDerString.length; i++) {
        binaryDer[i] = binaryDerString.charCodeAt(i)
    }

    return await crypto.subtle.importKey(
        "pkcs8",
        binaryDer,
        {
            name: "RSASSA-PKCS1-v1_5",
            hash: "SHA-256",
        },
        false,
        ["sign"]
    )
}