/** i18n for the public booking surface — EN/ES message catalogs + interpolation. */

export type Locale = 'en' | 'es';

export interface BookingMessages {
  booking: {
    selectTime: string;
    durationMinutes: string;
    timezoneLabel: string;
    timezone: string;
    noSlots: string;
    book: string;
    confirm: string;
    confirming: string;
    confirmed: string;
    requested: string;
    awaitingConfirmation: string;
    yourName: string;
    yourEmail: string;
    notes: string;
    heldUntil: string;
    slotTaken: string;
    holdExpired: string;
    pickAnother: string;
    retry: string;
    poweredBy: string;
    with: string;
    seatsLeft: string;
    full: string;
  };
  manage: {
    title: string;
    reschedule: string;
    rescheduling: string;
    rescheduleTo: string;
    cancel: string;
    cancelling: string;
    cancelReason: string;
    cancelled: string;
    rescheduled: string;
    cannotChange: string;
    withLabel: string;
    bookingIs: string;
    alreadyTookPlace: string;
    statusPending: string;
    statusCancelled: string;
    statusRejected: string;
    cancelThis: string;
    noOpenTimes: string;
    whereLabel: string;
    joinMeeting: string;
  };
  /** Admin dashboard surface (F8 parity). Reuses the same catalog/locale mechanism. */
  admin: {
    nav: {
      home: string;
      bookings: string;
      availability: string;
      eventTypes: string;
      teams: string;
      settings: string;
      bookingPage: string;
    };
    common: {
      save: string;
      saving: string;
      cancel: string;
      delete: string;
      deleting: string;
      edit: string;
      remove: string;
      add: string;
      create: string;
      creating: string;
      confirm: string;
      back: string;
      retry: string;
      loading: string;
      saved: string;
      search: string;
      none: string;
      signOut: string;
      viewPublic: string;
      language: string;
      collapse: string;
      expand: string;
    };
    home: {
      welcome: string;
      welcomeNamed: string;
      subtitle: string;
      bookingLink: string;
      setHandlePre: string;
      setHandleLink: string;
      setHandlePost: string;
      statEventTypes: string;
      statUpcoming: string;
      statTeams: string;
      createEvent: string;
      createEventDesc: string;
      setAvailability: string;
      setAvailabilityDesc: string;
      stylePage: string;
      stylePageDesc: string;
      apiKeys: string;
      apiKeysDesc: string;
    };
    settings: {
      title: string;
      subtitle: string;
      general: string;
      bookingPage: string;
      calendars: string;
      developer: string;
    };
    eventTypes: {
      title: string;
      newEventType: string;
      emptyList: string;
      hidden: string;
      needsConfirmation: string;
      minSuffix: string;
      fTitle: string;
      fSlug: string;
      fDescription: string;
      fLocation: string;
      locationPlaceholder: string;
      fLength: string;
      fSlotInterval: string;
      fMinNotice: string;
      fBufferBefore: string;
      fBufferAfter: string;
      fSeats: string;
      fSchedule: string;
      useDefaultSchedule: string;
      noSchedules: string;
      requiresConfirmation: string;
      hiddenLabel: string;
      intakeQuestions: string;
      namePlaceholder: string;
      labelPlaceholder: string;
      req: string;
      addQuestion: string;
      saved: string;
      saveChanges: string;
      createEventType: string;
      saving: string;
    };
    availability: {
      title: string;
      subtitle: string;
      emptyList: string;
      weeklyHours: string;
      dateOverrides: string;
      timezone: string;
      unavailable: string;
      addRange: string;
      addOverride: string;
      overrideNote: string;
      deleteSchedule: string;
      deletePrompt: string;
      yes: string;
      no: string;
      save: string;
      saving: string;
      scheduleNameLabel: string;
      removeRange: string;
      savedToast: string;
      deletedToast: string;
      saveError: string;
      deleteError: string;
      newSchedule: string;
      newSchedulePlaceholder: string;
      create: string;
      days: string[];
    };
    bookings: {
      title: string;
      newBooking: string;
      pendingConfirmation: string;
      upcoming: string;
      pastCancelled: string;
      nothingHere: string;
      confirm: string;
      decline: string;
      cancel: string;
      cancelPrompt: string;
      yes: string;
      no: string;
      confirmedToast: string;
      declinedToast: string;
      cancelledToast: string;
      cancelError: string;
      genericError: string;
      statusAccepted: string;
      statusPending: string;
      statusCancelled: string;
      statusRejected: string;
      newTitle: string;
      eventType: string;
      fromSlots: string;
      anyTime: string;
      noSlotsRange: string;
      dateTimeHost: string;
      attendeeName: string;
      attendeeEmail: string;
      attendeeTimezone: string;
      pickTime: string;
      creating: string;
      createBooking: string;
      createdTitle: string;
      createdNote: string;
      backToBookings: string;
      newSubtitle: string;
      createEventFirst: string;
      slotTaken: string;
    };
    teams: {
      title: string;
      subtitle: string;
      emptyList: string;
      newTeam: string;
      name: string;
      slug: string;
      timezone: string;
      createTeam: string;
      manage: string;
      delete: string;
      cancel: string;
      deleteError: string;
      memberSingular: string;
      memberPlural: string;
      noMembers: string;
      addMember: string;
      chooseSomeone: string;
      role: string;
      roleOwner: string;
      roleMember: string;
      add: string;
      allOnTeam: string;
      remove: string;
      lastOwner: string;
      lastOwnerTitle: string;
      roleUpdated: string;
      memberRemoved: string;
      memberAdded: string;
      genericError: string;
      backToTeams: string;
      viewPublicTeam: string;
      roundRobin: string;
      members: string;
      teamEventTypes: string;
      noTeamEventTypes: string;
      inviteTitle: string;
      inviteLead: string;
      emailLabel: string;
      emailPlaceholder: string;
      emailInvalid: string;
      sendInvite: string;
      ownerLock: string;
      memberPending: string;
      noAccountMember: string;
      createTitle: string;
      createSubtitle: string;
      bioLabel: string;
      bioPlaceholder: string;
      logoLabel: string;
      uploadImage: string;
      orPasteUrl: string;
      clearImage: string;
      imageTooLarge: string;
      imageInvalidType: string;
      creating: string;
      backToTeamsList: string;
      imageReadError: string;
      nameHelp: string;
      slugHelp: string;
      bioHelp: string;
      logoHelp: string;
    };
    connections: {
      pageDesc: string;
      dialogTitle: string;
      dialogSubtitle: string;
      close: string;
      providerGoogle: string;
      providerOutlook: string;
      syncOnTitle: string;
      syncOnDesc: string;
      connectButton: string;
      syncOffTitle: string;
      syncOffDesc: string;
      syncOffSetPre: string;
      syncOffSetPost: string;
      connectLink: string;
      destination: string;
      conflictCheck: string;
      test: string;
      disconnect: string;
      disconnectError: string;
      noCalendars: string;
      manualTitle: string;
      manualDesc: string;
      provider: string;
      calendarId: string;
      addConnection: string;
      healthSyncing: string;
      healthRecorded: string;
      destinationHelp: string;
      conflictHelp: string;
    };
    login: {
      title: string;
      subtitle: string;
      continue: string;
      footnote: string;
    };
    settingsGeneral: {
      displayName: string;
      publicHandle: string;
      timezone: string;
      saved: string;
      save: string;
      saving: string;
    };
    developer: {
      apiKeys: string;
      noKeys: string;
      revoke: string;
      revoked: string;
      copyOnce: string;
      name: string;
      scopes: string;
      createKey: string;
      webhooks: string;
      noWebhooks: string;
      subscriberUrl: string;
      events: string;
      addWebhook: string;
      ping: string;
      delete: string;
      active: string;
      cancel: string;
    };
    bookingPageHeader: {
      title: string;
      subtitle: string;
    };
    studio: {
      unsavedChanges: string;
      allChangesSaved: string;
      saved: string;
      reset: string;
      save: string;
      saving: string;
      saveFailed: string;
      profile: string;
      brand: string;
      appearance: string;
      meetings: string;
      displayName: string;
      publicHandle: string;
      bio: string;
      tryHandle: string;
      accent: string;
      contrast: string;
      adjustedNote: string;
      photoAvatar: string;
      coverImage: string;
      custom: string;
      customizeAppearance: string;
      axisTemplate: string;
      axisCardStyle: string;
      axisCorners: string;
      axisButtons: string;
      axisDensity: string;
      axisFont: string;
      axisSlotLayout: string;
      axisDayGroup: string;
      axisSlotSelect: string;
      show: string;
      hide: string;
      noEvents: string;
      orderVisibilityNote: string;
      configureEventTypes: string;
      showLandingPage: string;
      sendVisitorsTo: string;
      chooseEvent: string;
      pickDefaultEvent: string;
      eventHidden: string;
      eventShown: string;
      couldNotUpdateVisibility: string;
      moveUp: string;
      moveDown: string;
      previewProfile: string;
      bookingFlow: string;
      desktop: string;
      mobile: string;
      checking: string;
      available: string;
      taken: string;
      invalid: string;
      uploadImage: string;
      clear: string;
      orPasteUrl: string;
      imageInvalid: string;
      imageTooLarge: string;
      couldNotRead: string;
      introCall: string;
      minSuffix: string;
    };
  };
}

export const en: BookingMessages = {
  booking: {
    selectTime: 'Select a time',
    durationMinutes: '{minutes} min',
    timezoneLabel: 'Times shown in {timeZone}',
    timezone: 'Timezone',
    noSlots: 'No available times in this range.',
    book: 'Book',
    confirm: 'Confirm booking',
    confirming: 'Confirming…',
    confirmed: 'Booking confirmed',
    requested: 'Booking requested',
    awaitingConfirmation: 'Awaiting the host’s confirmation. We’ll email {email} once it’s confirmed.',
    yourName: 'Your name',
    yourEmail: 'Your email',
    notes: 'Notes (optional)',
    heldUntil: 'Held until {time}',
    slotTaken: 'That time was just taken.',
    holdExpired: 'Your hold expired',
    pickAnother: 'Pick another time',
    retry: 'Try again',
    poweredBy: 'Powered by Slate',
    with: 'with',
    seatsLeft: '{n} left',
    full: 'Full',
  },
  manage: {
    title: 'Manage your booking',
    reschedule: 'Reschedule',
    rescheduling: 'Rescheduling…',
    rescheduleTo: 'Reschedule to',
    cancel: 'Cancel booking',
    cancelling: 'Cancelling…',
    cancelReason: 'Reason (optional)',
    cancelled: 'Your booking has been cancelled.',
    rescheduled: 'Your booking has been rescheduled. Check your email for the updated invite.',
    cannotChange: 'This booking can no longer be changed.',
    withLabel: 'With',
    bookingIs: 'This booking is {status}.',
    alreadyTookPlace: 'This booking has already taken place.',
    statusPending: 'pending',
    statusCancelled: 'cancelled',
    statusRejected: 'rejected',
    cancelThis: 'Cancel this booking',
    noOpenTimes: 'No open times in the next 3 weeks.',
    whereLabel: 'Where',
    joinMeeting: 'Join the meeting',
  },
  admin: {
    nav: {
      home: 'Home',
      bookings: 'Bookings',
      availability: 'Availability',
      eventTypes: 'Event types',
      teams: 'Teams',
      settings: 'Settings',
      bookingPage: 'Booking page',
    },
    common: {
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      delete: 'Delete',
      deleting: 'Deleting…',
      edit: 'Edit',
      remove: 'Remove',
      add: 'Add',
      create: 'Create',
      creating: 'Creating…',
      confirm: 'Confirm',
      back: 'Back',
      retry: 'Try again',
      loading: 'Loading…',
      saved: 'All changes saved',
      search: 'Search',
      none: 'None',
      signOut: 'Sign out',
      viewPublic: 'View public page',
      language: 'Language',
      collapse: 'Collapse sidebar',
      expand: 'Expand sidebar',
    },
    home: {
      welcome: 'Welcome',
      welcomeNamed: 'Welcome, {name}',
      subtitle: 'Your scheduling at a glance.',
      bookingLink: 'Your booking link',
      setHandlePre: 'Set a handle in',
      setHandleLink: 'your booking page',
      setHandlePost: 'to get a shareable link.',
      statEventTypes: 'Event types',
      statUpcoming: 'Upcoming bookings',
      statTeams: 'Teams',
      createEvent: 'Create an event type',
      createEventDesc: 'Define a bookable meeting.',
      setAvailability: 'Set your availability',
      setAvailabilityDesc: 'Weekly hours + date overrides.',
      stylePage: 'Style your booking page',
      stylePageDesc: 'Brand + 9-axis studio.',
      apiKeys: 'API keys & webhooks',
      apiKeysDesc: 'Integrate agents & automations.',
    },
    settings: {
      title: 'Settings',
      subtitle: 'Manage your account and preferences.',
      general: 'General',
      bookingPage: 'Booking Page',
      calendars: 'Calendars',
      developer: 'Developer',
    },
    eventTypes: {
      title: 'Event Types',
      newEventType: 'New event type',
      emptyList: 'No event types yet — create one below.',
      hidden: 'hidden',
      needsConfirmation: 'needs confirmation',
      minSuffix: 'min',
      fTitle: 'Title',
      fSlug: 'Slug',
      fDescription: 'Description',
      fLocation: 'Location',
      locationPlaceholder: 'e.g. Google Meet, Phone, or an address',
      fLength: 'Length (min)',
      fSlotInterval: 'Slot interval (min)',
      fMinNotice: 'Min. notice (min)',
      fBufferBefore: 'Buffer before (min)',
      fBufferAfter: 'Buffer after (min)',
      fSeats: 'Seats / slot (group)',
      fSchedule: 'Availability schedule',
      useDefaultSchedule: 'Use my default schedule',
      noSchedules: 'No schedules yet — create one in Availability',
      requiresConfirmation: 'Requires confirmation',
      hiddenLabel: 'Hidden',
      intakeQuestions: 'Intake questions',
      namePlaceholder: 'name',
      labelPlaceholder: 'Label',
      req: 'req',
      addQuestion: '+ Add question',
      saved: 'Saved.',
      saveChanges: 'Save changes',
      createEventType: 'Create event type',
      saving: 'Saving…',
    },
    availability: {
      title: 'Availability',
      subtitle: 'Weekly hours and date overrides. Add multiple ranges per day (e.g. 9–12 and 14–18).',
      emptyList: 'No schedules yet — create one to set your weekly hours.',
      weeklyHours: 'Weekly hours',
      dateOverrides: 'Date overrides',
      timezone: 'Timezone',
      unavailable: 'Unavailable',
      addRange: '+ Add a range',
      addOverride: '+ Add date override',
      overrideNote: 'An override replaces the weekly hours for that specific date.',
      deleteSchedule: 'Delete',
      deletePrompt: 'Delete?',
      yes: 'Yes',
      no: 'No',
      save: 'Save availability',
      saving: 'Saving…',
      scheduleNameLabel: 'Schedule name',
      removeRange: 'Remove range',
      savedToast: 'Availability saved.',
      deletedToast: 'Schedule deleted.',
      saveError: 'Could not save availability.',
      deleteError: 'Could not delete the schedule.',
      newSchedule: 'New schedule',
      newSchedulePlaceholder: 'Schedule name',
      create: 'Create schedule',
      days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    },
    bookings: {
      title: 'Bookings',
      newBooking: '+ New booking',
      pendingConfirmation: 'Pending confirmation',
      upcoming: 'Upcoming',
      pastCancelled: 'Past & cancelled',
      nothingHere: 'Nothing here.',
      confirm: 'Confirm',
      decline: 'Decline',
      cancel: 'Cancel',
      cancelPrompt: 'Cancel?',
      yes: 'Yes',
      no: 'No',
      confirmedToast: 'Booking confirmed.',
      declinedToast: 'Booking declined.',
      cancelledToast: 'Booking cancelled.',
      cancelError: 'Could not cancel the booking.',
      genericError: 'Something went wrong.',
      statusAccepted: 'accepted',
      statusPending: 'pending',
      statusCancelled: 'cancelled',
      statusRejected: 'rejected',
      newTitle: 'New booking',
      eventType: 'Event type',
      fromSlots: 'From available slots',
      anyTime: 'Any time (outside availability)',
      noSlotsRange: 'No slots in range.',
      dateTimeHost: 'Date & time (host timezone)',
      attendeeName: 'Attendee name',
      attendeeEmail: 'Attendee email',
      attendeeTimezone: 'Attendee timezone',
      pickTime: 'Pick a time.',
      creating: 'Creating…',
      createBooking: 'Create booking',
      createdTitle: 'Booking created',
      createdNote: 'The attendee has been notified.',
      backToBookings: '← Back to bookings',
      newSubtitle: 'Book on behalf of an attendee — from an open slot or any time.',
      createEventFirst: 'Create an event type first.',
      slotTaken: 'That time was just taken — pick another slot.',
    },
    teams: {
      title: 'Teams',
      subtitle: 'Round-robin scheduling across a group of hosts.',
      emptyList: 'No teams yet — create one below to round-robin bookings across hosts.',
      newTeam: 'New team',
      name: 'Name',
      slug: 'Slug',
      timezone: 'Timezone',
      createTeam: 'Create team',
      manage: 'Manage',
      delete: 'Delete',
      cancel: 'Cancel',
      deleteError: 'Could not delete.',
      memberSingular: 'member',
      memberPlural: 'members',
      noMembers: 'No members yet. Add someone from your account below.',
      addMember: 'Add member',
      chooseSomeone: 'Choose someone…',
      role: 'Role',
      roleOwner: 'Owner',
      roleMember: 'Member',
      add: 'Add',
      allOnTeam: 'All account members are on this team.',
      remove: 'Remove',
      lastOwner: 'Last owner',
      lastOwnerTitle: 'A team must keep at least one owner',
      roleUpdated: 'Role updated.',
      memberRemoved: 'Member removed.',
      memberAdded: 'Member added.',
      genericError: 'Something went wrong.',
      backToTeams: '← Teams',
      viewPublicTeam: 'View public team page →',
      roundRobin: 'round-robin scheduling',
      members: 'Members',
      teamEventTypes: 'Team event types',
      noTeamEventTypes: 'No team event types yet.',
      inviteTitle: 'Add a member',
      inviteLead: 'Invite someone from your account to this team by email.',
      emailLabel: 'Email',
      emailPlaceholder: 'name@company.com',
      emailInvalid: 'Enter a valid email address.',
      sendInvite: 'Add member',
      ownerLock: 'Owners can’t be removed — change their role first.',
      memberPending: 'Pending',
      noAccountMember: 'No account member with that email — they need to sign up first.',
      createTitle: 'New team',
      createSubtitle: 'Round-robin bookings across a group of hosts. You can add members after creating.',
      bioLabel: 'Bio',
      bioPlaceholder: 'A short description shown on the team’s public page.',
      logoLabel: 'Logo',
      uploadImage: 'Upload image',
      orPasteUrl: '…or paste an image URL',
      clearImage: 'Clear',
      imageTooLarge: 'Image must be 1MB or smaller.',
      imageInvalidType: 'Please choose an image file.',
      creating: 'Creating…',
      backToTeamsList: '← Teams',
      imageReadError: 'Could not read that file.',
      nameHelp: 'Shown at the top of the team’s public booking page.',
      slugHelp: 'Used in the public URL. Lowercase letters, numbers and dashes.',
      bioHelp: 'A short line under the team name on the public page.',
      logoHelp: 'Square image works best. Max 1MB.',
    },
    connections: {
      pageDesc: 'Connect a calendar so Slate can check conflicts (busy times) and write your booked events to it.',
      dialogTitle: 'Connect a calendar',
      dialogSubtitle: 'Choose a provider to link.',
      close: 'Close',
      providerGoogle: 'Google Calendar',
      providerOutlook: 'Outlook / Microsoft 365',
      syncOnTitle: 'Calendar sync is on.',
      syncOnDesc: 'Connect Google or Outlook to check conflicts and write events.',
      connectButton: 'Connect a calendar',
      syncOffTitle: 'Calendar sync is off in this build',
      syncOffDesc: 'No external calendar provider is configured, so Slate isn’t reading busy times or writing events yet. Connections you add below are recorded but not synced.',
      syncOffSetPre: 'To turn sync on, set',
      syncOffSetPost: 'and configure a provider adapter in your deployment.',
      connectLink: 'Connect a calendar →',
      destination: 'Destination',
      conflictCheck: 'Conflict check',
      test: 'Test',
      disconnect: 'Disconnect',
      disconnectError: 'Could not disconnect.',
      noCalendars: 'No calendars linked yet.',
      manualTitle: 'Link a calendar manually',
      manualDesc: 'Advanced: record a calendar reference by id (used when a provider adapter is configured, or for testing).',
      provider: 'Provider',
      calendarId: 'Calendar id / email',
      addConnection: 'Add connection',
      healthSyncing: 'Syncing',
      healthRecorded: 'Recorded only',
      destinationHelp: 'Booked events are written to this calendar.',
      conflictHelp: 'Busy times here block new bookings.',
    },
    login: {
      title: 'Sign in',
      subtitle: 'Open-source scheduling. This build uses the local dev provider — configure WorkOS in your deployment for real accounts.',
      continue: 'Continue',
      footnote: 'No account needed in local mode — you’re signed in as the seeded host.',
    },
    settingsGeneral: {
      displayName: 'Display name',
      publicHandle: 'Public handle',
      timezone: 'Timezone',
      saved: 'Saved.',
      save: 'Save',
      saving: 'Saving…',
    },
    developer: {
      apiKeys: 'API keys',
      noKeys: 'No API keys.',
      revoke: 'Revoke',
      revoked: 'revoked',
      copyOnce: 'Copy this now — it won’t be shown again:',
      name: 'Name',
      scopes: 'Scopes',
      createKey: 'Create key',
      webhooks: 'Webhooks',
      noWebhooks: 'No webhooks.',
      subscriberUrl: 'Subscriber URL',
      events: 'Events',
      addWebhook: 'Add webhook',
      ping: 'Ping',
      delete: 'Delete',
      active: 'active',
      cancel: 'Cancel',
    },
    bookingPageHeader: {
      title: 'Booking Page',
      subtitle: 'Style your public page. Preview updates live — what you see is what visitors get.',
    },
    studio: {
      unsavedChanges: 'Unsaved changes',
      allChangesSaved: 'All changes saved',
      saved: 'Saved.',
      reset: 'Reset',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'Save failed.',
      profile: 'Profile',
      brand: 'Brand',
      appearance: 'Appearance',
      meetings: 'Meetings',
      displayName: 'Display name',
      publicHandle: 'Public handle',
      bio: 'Bio',
      tryHandle: 'Try {handle} →',
      accent: 'Accent',
      contrast: 'Contrast {ratio}:1',
      adjustedNote: ' · adjusted to {hex} for legibility (AA)',
      photoAvatar: 'Photo / avatar',
      coverImage: 'Cover image',
      custom: 'Custom',
      customizeAppearance: 'Customize appearance',
      axisTemplate: 'Template',
      axisCardStyle: 'Card style',
      axisCorners: 'Corners',
      axisButtons: 'Buttons',
      axisDensity: 'Density',
      axisFont: 'Font',
      axisSlotLayout: 'Slot layout',
      axisDayGroup: 'Day group',
      axisSlotSelect: 'Slot select',
      show: 'Show',
      hide: 'Hide',
      noEvents: 'No events yet.',
      orderVisibilityNote: 'Order + visibility apply to your public page.',
      configureEventTypes: 'Configure event types →',
      showLandingPage: 'Show the landing page (list of events)',
      sendVisitorsTo: 'Send visitors directly to',
      chooseEvent: 'Choose an event…',
      pickDefaultEvent: 'Pick a default event, or keep the landing page on.',
      eventHidden: 'Event hidden.',
      eventShown: 'Event shown.',
      couldNotUpdateVisibility: 'Could not update visibility.',
      moveUp: 'Move up',
      moveDown: 'Move down',
      previewProfile: 'Profile',
      bookingFlow: 'Booking flow',
      desktop: 'desktop',
      mobile: 'mobile',
      checking: 'Checking…',
      available: '✓ Available',
      taken: '✗ Taken',
      invalid: 'Invalid (3–40 chars, a–z 0–9 -)',
      uploadImage: 'Upload image',
      clear: 'Clear',
      orPasteUrl: '…or paste an image URL',
      imageInvalid: 'Please choose an image file.',
      imageTooLarge: 'Image must be under 1 MB.',
      couldNotRead: 'Could not read that file.',
      introCall: 'Intro Call',
      minSuffix: 'min',
    },
  },
};

export const es: BookingMessages = {
  booking: {
    selectTime: 'Selecciona un horario',
    durationMinutes: '{minutes} min',
    timezoneLabel: 'Horarios en {timeZone}',
    timezone: 'Zona horaria',
    noSlots: 'No hay horarios disponibles en este rango.',
    book: 'Reservar',
    confirm: 'Confirmar reserva',
    confirming: 'Confirmando…',
    confirmed: 'Reserva confirmada',
    requested: 'Reserva solicitada',
    awaitingConfirmation: 'Esperando la confirmación del anfitrión. Te escribiremos a {email} cuando se confirme.',
    yourName: 'Tu nombre',
    yourEmail: 'Tu correo',
    notes: 'Notas (opcional)',
    heldUntil: 'Reservado hasta las {time}',
    slotTaken: 'Ese horario acaba de ocuparse.',
    holdExpired: 'Tu reserva temporal expiró',
    pickAnother: 'Elige otro horario',
    retry: 'Reintentar',
    poweredBy: 'Con la tecnología de Slate',
    with: 'con',
    seatsLeft: '{n} disponibles',
    full: 'Lleno',
  },
  manage: {
    title: 'Gestiona tu reserva',
    reschedule: 'Reprogramar',
    rescheduling: 'Reprogramando…',
    rescheduleTo: 'Reprogramar para',
    cancel: 'Cancelar reserva',
    cancelling: 'Cancelando…',
    cancelReason: 'Motivo (opcional)',
    cancelled: 'Tu reserva ha sido cancelada.',
    rescheduled: 'Tu reserva fue reprogramada. Revisa tu correo para la invitación actualizada.',
    cannotChange: 'Esta reserva ya no se puede cambiar.',
    withLabel: 'Con',
    bookingIs: 'Esta reserva está {status}.',
    alreadyTookPlace: 'Esta reserva ya se realizó.',
    statusPending: 'pendiente',
    statusCancelled: 'cancelada',
    statusRejected: 'rechazada',
    cancelThis: 'Cancelar esta reserva',
    noOpenTimes: 'No hay horarios disponibles en las próximas 3 semanas.',
    whereLabel: 'Dónde',
    joinMeeting: 'Unirse a la reunión',
  },
  admin: {
    nav: {
      home: 'Inicio',
      bookings: 'Reservas',
      availability: 'Disponibilidad',
      eventTypes: 'Tipos de evento',
      teams: 'Equipos',
      settings: 'Ajustes',
      bookingPage: 'Página de reservas',
    },
    common: {
      save: 'Guardar',
      saving: 'Guardando…',
      cancel: 'Cancelar',
      delete: 'Eliminar',
      deleting: 'Eliminando…',
      edit: 'Editar',
      remove: 'Quitar',
      add: 'Añadir',
      create: 'Crear',
      creating: 'Creando…',
      confirm: 'Confirmar',
      back: 'Volver',
      retry: 'Reintentar',
      loading: 'Cargando…',
      saved: 'Todos los cambios guardados',
      search: 'Buscar',
      none: 'Ninguno',
      signOut: 'Cerrar sesión',
      viewPublic: 'Ver página pública',
      language: 'Idioma',
      collapse: 'Contraer barra lateral',
      expand: 'Expandir barra lateral',
    },
    home: {
      welcome: 'Bienvenido',
      welcomeNamed: 'Bienvenido, {name}',
      subtitle: 'Tu agenda de un vistazo.',
      bookingLink: 'Tu enlace de reservas',
      setHandlePre: 'Configura un identificador en',
      setHandleLink: 'tu página de reservas',
      setHandlePost: 'para obtener un enlace para compartir.',
      statEventTypes: 'Tipos de evento',
      statUpcoming: 'Próximas reservas',
      statTeams: 'Equipos',
      createEvent: 'Crear un tipo de evento',
      createEventDesc: 'Define una reunión reservable.',
      setAvailability: 'Configura tu disponibilidad',
      setAvailabilityDesc: 'Horas semanales + excepciones por fecha.',
      stylePage: 'Personaliza tu página de reservas',
      stylePageDesc: 'Marca + estudio de 9 ejes.',
      apiKeys: 'Claves API y webhooks',
      apiKeysDesc: 'Integra agentes y automatizaciones.',
    },
    settings: {
      title: 'Ajustes',
      subtitle: 'Gestiona tu cuenta y preferencias.',
      general: 'General',
      bookingPage: 'Página de reservas',
      calendars: 'Calendarios',
      developer: 'Desarrollador',
    },
    eventTypes: {
      title: 'Tipos de evento',
      newEventType: 'Nuevo tipo de evento',
      emptyList: 'Aún no hay tipos de evento — crea uno abajo.',
      hidden: 'oculto',
      needsConfirmation: 'requiere confirmación',
      minSuffix: 'min',
      fTitle: 'Título',
      fSlug: 'Identificador',
      fDescription: 'Descripción',
      fLocation: 'Ubicación',
      locationPlaceholder: 'p. ej. Google Meet, Teléfono o una dirección',
      fLength: 'Duración (min)',
      fSlotInterval: 'Intervalo entre horarios (min)',
      fMinNotice: 'Antelación mínima (min)',
      fBufferBefore: 'Margen antes (min)',
      fBufferAfter: 'Margen después (min)',
      fSeats: 'Cupos / horario (grupo)',
      fSchedule: 'Horario de disponibilidad',
      useDefaultSchedule: 'Usar mi horario predeterminado',
      noSchedules: 'Aún no hay horarios — crea uno en Disponibilidad',
      requiresConfirmation: 'Requiere confirmación',
      hiddenLabel: 'Oculto',
      intakeQuestions: 'Preguntas del formulario',
      namePlaceholder: 'nombre',
      labelPlaceholder: 'Etiqueta',
      req: 'obl.',
      addQuestion: '+ Añadir pregunta',
      saved: 'Guardado.',
      saveChanges: 'Guardar cambios',
      createEventType: 'Crear tipo de evento',
      saving: 'Guardando…',
    },
    availability: {
      title: 'Disponibilidad',
      subtitle: 'Horas semanales y excepciones por fecha. Añade varios rangos por día (p. ej. 9–12 y 14–18).',
      emptyList: 'Aún no hay horarios — crea uno para definir tus horas semanales.',
      weeklyHours: 'Horas semanales',
      dateOverrides: 'Excepciones por fecha',
      timezone: 'Zona horaria',
      unavailable: 'No disponible',
      addRange: '+ Añadir un rango',
      addOverride: '+ Añadir excepción por fecha',
      overrideNote: 'Una excepción reemplaza las horas semanales para esa fecha específica.',
      deleteSchedule: 'Eliminar',
      deletePrompt: '¿Eliminar?',
      yes: 'Sí',
      no: 'No',
      save: 'Guardar disponibilidad',
      saving: 'Guardando…',
      scheduleNameLabel: 'Nombre del horario',
      removeRange: 'Quitar rango',
      savedToast: 'Disponibilidad guardada.',
      deletedToast: 'Horario eliminado.',
      saveError: 'No se pudo guardar la disponibilidad.',
      deleteError: 'No se pudo eliminar el horario.',
      newSchedule: 'Nuevo horario',
      newSchedulePlaceholder: 'Nombre del horario',
      create: 'Crear horario',
      days: ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'],
    },
    bookings: {
      title: 'Reservas',
      newBooking: '+ Nueva reserva',
      pendingConfirmation: 'Pendientes de confirmación',
      upcoming: 'Próximas',
      pastCancelled: 'Pasadas y canceladas',
      nothingHere: 'Nada por aquí.',
      confirm: 'Confirmar',
      decline: 'Rechazar',
      cancel: 'Cancelar',
      cancelPrompt: '¿Cancelar?',
      yes: 'Sí',
      no: 'No',
      confirmedToast: 'Reserva confirmada.',
      declinedToast: 'Reserva rechazada.',
      cancelledToast: 'Reserva cancelada.',
      cancelError: 'No se pudo cancelar la reserva.',
      genericError: 'Algo salió mal.',
      statusAccepted: 'aceptada',
      statusPending: 'pendiente',
      statusCancelled: 'cancelada',
      statusRejected: 'rechazada',
      newTitle: 'Nueva reserva',
      eventType: 'Tipo de evento',
      fromSlots: 'Desde horarios disponibles',
      anyTime: 'Cualquier hora (fuera de disponibilidad)',
      noSlotsRange: 'No hay horarios en el rango.',
      dateTimeHost: 'Fecha y hora (zona del anfitrión)',
      attendeeName: 'Nombre del invitado',
      attendeeEmail: 'Correo del invitado',
      attendeeTimezone: 'Zona horaria del invitado',
      pickTime: 'Elige una hora.',
      creating: 'Creando…',
      createBooking: 'Crear reserva',
      createdTitle: 'Reserva creada',
      createdNote: 'Se ha notificado al invitado.',
      backToBookings: '← Volver a reservas',
      newSubtitle: 'Reserva en nombre de un invitado — desde un horario libre o cualquier hora.',
      createEventFirst: 'Primero crea un tipo de evento.',
      slotTaken: 'Ese horario acaba de ocuparse — elige otro.',
    },
    teams: {
      title: 'Equipos',
      subtitle: 'Programación por turnos entre un grupo de anfitriones.',
      emptyList: 'Aún no hay equipos — crea uno abajo para repartir reservas por turnos entre anfitriones.',
      newTeam: 'Nuevo equipo',
      name: 'Nombre',
      slug: 'Identificador',
      timezone: 'Zona horaria',
      createTeam: 'Crear equipo',
      manage: 'Gestionar',
      delete: 'Eliminar',
      cancel: 'Cancelar',
      deleteError: 'No se pudo eliminar.',
      memberSingular: 'miembro',
      memberPlural: 'miembros',
      noMembers: 'Aún no hay miembros. Añade a alguien de tu cuenta abajo.',
      addMember: 'Añadir miembro',
      chooseSomeone: 'Elige a alguien…',
      role: 'Rol',
      roleOwner: 'Propietario',
      roleMember: 'Miembro',
      add: 'Añadir',
      allOnTeam: 'Todos los miembros de la cuenta están en este equipo.',
      remove: 'Quitar',
      lastOwner: 'Último propietario',
      lastOwnerTitle: 'Un equipo debe conservar al menos un propietario',
      roleUpdated: 'Rol actualizado.',
      memberRemoved: 'Miembro eliminado.',
      memberAdded: 'Miembro añadido.',
      genericError: 'Algo salió mal.',
      backToTeams: '← Equipos',
      viewPublicTeam: 'Ver página pública del equipo →',
      roundRobin: 'programación por turnos',
      members: 'Miembros',
      teamEventTypes: 'Tipos de evento del equipo',
      noTeamEventTypes: 'Aún no hay tipos de evento del equipo.',
      inviteTitle: 'Añadir un miembro',
      inviteLead: 'Invita por correo a alguien de tu cuenta a este equipo.',
      emailLabel: 'Correo',
      emailPlaceholder: 'nombre@empresa.com',
      emailInvalid: 'Introduce un correo válido.',
      sendInvite: 'Añadir miembro',
      ownerLock: 'Los propietarios no se pueden quitar — cambia su rol primero.',
      memberPending: 'Pendiente',
      noAccountMember: 'No hay ningún miembro de la cuenta con ese correo — primero debe registrarse.',
      createTitle: 'Nuevo equipo',
      createSubtitle: 'Reparte reservas por turnos entre un grupo de anfitriones. Puedes añadir miembros después de crearlo.',
      bioLabel: 'Biografía',
      bioPlaceholder: 'Una breve descripción que se muestra en la página pública del equipo.',
      logoLabel: 'Logo',
      uploadImage: 'Subir imagen',
      orPasteUrl: '…o pega una URL de imagen',
      clearImage: 'Quitar',
      imageTooLarge: 'La imagen debe pesar 1MB o menos.',
      imageInvalidType: 'Elige un archivo de imagen.',
      creating: 'Creando…',
      backToTeamsList: '← Equipos',
      imageReadError: 'No se pudo leer el archivo.',
      nameHelp: 'Se muestra en la parte superior de la página pública del equipo.',
      slugHelp: 'Se usa en la URL pública. Minúsculas, números y guiones.',
      bioHelp: 'Una línea breve bajo el nombre del equipo en la página pública.',
      logoHelp: 'Una imagen cuadrada funciona mejor. Máx. 1MB.',
    },
    connections: {
      pageDesc: 'Conecta un calendario para que Slate pueda verificar conflictos (horas ocupadas) y escribir en él tus reservas.',
      dialogTitle: 'Conectar un calendario',
      dialogSubtitle: 'Elige un proveedor para vincular.',
      close: 'Cerrar',
      providerGoogle: 'Google Calendar',
      providerOutlook: 'Outlook / Microsoft 365',
      syncOnTitle: 'La sincronización de calendario está activa.',
      syncOnDesc: 'Conecta Google u Outlook para verificar conflictos y escribir eventos.',
      connectButton: 'Conectar un calendario',
      syncOffTitle: 'La sincronización de calendario está desactivada en esta versión',
      syncOffDesc: 'No hay ningún proveedor de calendario externo configurado, así que Slate aún no lee horas ocupadas ni escribe eventos. Las conexiones que añadas abajo se registran pero no se sincronizan.',
      syncOffSetPre: 'Para activar la sincronización, define',
      syncOffSetPost: 'y configura un adaptador de proveedor en tu despliegue.',
      connectLink: 'Conectar un calendario →',
      destination: 'Destino',
      conflictCheck: 'Verificar conflictos',
      test: 'Probar',
      disconnect: 'Desconectar',
      disconnectError: 'No se pudo desconectar.',
      noCalendars: 'Aún no hay calendarios vinculados.',
      manualTitle: 'Vincular un calendario manualmente',
      manualDesc: 'Avanzado: registra una referencia de calendario por id (se usa cuando hay un adaptador de proveedor configurado, o para pruebas).',
      provider: 'Proveedor',
      calendarId: 'Id de calendario / correo',
      addConnection: 'Añadir conexión',
      healthSyncing: 'Sincronizando',
      healthRecorded: 'Solo registrado',
      destinationHelp: 'Las reservas se escriben en este calendario.',
      conflictHelp: 'Las horas ocupadas aquí bloquean nuevas reservas.',
    },
    login: {
      title: 'Iniciar sesión',
      subtitle: 'Programación de código abierto. Esta versión usa el proveedor de desarrollo local — configura WorkOS en tu despliegue para cuentas reales.',
      continue: 'Continuar',
      footnote: 'No se necesita cuenta en modo local — has iniciado sesión como el anfitrión de ejemplo.',
    },
    settingsGeneral: {
      displayName: 'Nombre visible',
      publicHandle: 'Identificador público',
      timezone: 'Zona horaria',
      saved: 'Guardado.',
      save: 'Guardar',
      saving: 'Guardando…',
    },
    developer: {
      apiKeys: 'Claves API',
      noKeys: 'No hay claves API.',
      revoke: 'Revocar',
      revoked: 'revocada',
      copyOnce: 'Cópiala ahora — no se volverá a mostrar:',
      name: 'Nombre',
      scopes: 'Permisos',
      createKey: 'Crear clave',
      webhooks: 'Webhooks',
      noWebhooks: 'No hay webhooks.',
      subscriberUrl: 'URL del suscriptor',
      events: 'Eventos',
      addWebhook: 'Añadir webhook',
      ping: 'Probar',
      delete: 'Eliminar',
      active: 'activo',
      cancel: 'Cancelar',
    },
    bookingPageHeader: {
      title: 'Página de reservas',
      subtitle: 'Personaliza tu página pública. La vista previa se actualiza en vivo — lo que ves es lo que reciben los visitantes.',
    },
    studio: {
      unsavedChanges: 'Cambios sin guardar',
      allChangesSaved: 'Todos los cambios guardados',
      saved: 'Guardado.',
      reset: 'Restablecer',
      save: 'Guardar',
      saving: 'Guardando…',
      saveFailed: 'Error al guardar.',
      profile: 'Perfil',
      brand: 'Marca',
      appearance: 'Apariencia',
      meetings: 'Reuniones',
      displayName: 'Nombre visible',
      publicHandle: 'Identificador público',
      bio: 'Biografía',
      tryHandle: 'Prueba {handle} →',
      accent: 'Color de acento',
      contrast: 'Contraste {ratio}:1',
      adjustedNote: ' · ajustado a {hex} para mejor legibilidad (AA)',
      photoAvatar: 'Foto / avatar',
      coverImage: 'Imagen de portada',
      custom: 'Personalizado',
      customizeAppearance: 'Personalizar apariencia',
      axisTemplate: 'Plantilla',
      axisCardStyle: 'Estilo de tarjeta',
      axisCorners: 'Esquinas',
      axisButtons: 'Botones',
      axisDensity: 'Densidad',
      axisFont: 'Fuente',
      axisSlotLayout: 'Disposición de horarios',
      axisDayGroup: 'Agrupación por día',
      axisSlotSelect: 'Selección de horario',
      show: 'Mostrar',
      hide: 'Ocultar',
      noEvents: 'Aún no hay eventos.',
      orderVisibilityNote: 'El orden y la visibilidad se aplican a tu página pública.',
      configureEventTypes: 'Configurar tipos de evento →',
      showLandingPage: 'Mostrar la página de inicio (lista de eventos)',
      sendVisitorsTo: 'Enviar a los visitantes directamente a',
      chooseEvent: 'Elige un evento…',
      pickDefaultEvent: 'Elige un evento predeterminado o deja activa la página de inicio.',
      eventHidden: 'Evento oculto.',
      eventShown: 'Evento visible.',
      couldNotUpdateVisibility: 'No se pudo actualizar la visibilidad.',
      moveUp: 'Subir',
      moveDown: 'Bajar',
      previewProfile: 'Perfil',
      bookingFlow: 'Flujo de reserva',
      desktop: 'escritorio',
      mobile: 'móvil',
      checking: 'Comprobando…',
      available: '✓ Disponible',
      taken: '✗ Ocupado',
      invalid: 'No válido (3–40 caracteres, a–z 0–9 -)',
      uploadImage: 'Subir imagen',
      clear: 'Quitar',
      orPasteUrl: '…o pega una URL de imagen',
      imageInvalid: 'Elige un archivo de imagen.',
      imageTooLarge: 'La imagen debe pesar menos de 1 MB.',
      couldNotRead: 'No se pudo leer el archivo.',
      introCall: 'Llamada de introducción',
      minSuffix: 'min',
    },
  },
};

export const messages = { en, es } as const;

/** Pick messages for a locale, defaulting to English. */
export function getMessages(locale: string): BookingMessages {
  return locale.startsWith('es') ? es : en;
}

/** Interpolate `{name}` placeholders in a message string. */
export function t(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}
