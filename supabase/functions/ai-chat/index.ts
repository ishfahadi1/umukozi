// The public AI assistant was removed. Only the admin AI (admin-ai) exists now.
Deno.serve(() => new Response(JSON.stringify({ error: 'removed' }), { status: 410, headers: { 'Content-Type': 'application/json' } }));
