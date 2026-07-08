'use server';

import { revalidatePath } from 'next/cache';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function post(uid: string, action: 'confirm' | 'decline' | 'cancel'): Promise<void> {
  await fetch(`${API}/v1/host/bookings/${encodeURIComponent(uid)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    cache: 'no-store',
  });
  revalidatePath('/admin/bookings');
}

export async function confirmBookingAction(uid: string): Promise<void> {
  await post(uid, 'confirm');
}
export async function declineBookingAction(uid: string): Promise<void> {
  await post(uid, 'decline');
}
export async function cancelBookingAction(uid: string): Promise<void> {
  await post(uid, 'cancel');
}
