/** i18n for the public booking surface — EN/ES message catalogs + interpolation. */

export type Locale = 'en' | 'es';

/** The notification-email catalog (mirrors @slate/notifications EMAIL_TEMPLATE_KEYS). */
export type NotificationEmailKey =
  | 'attendee_confirmation'
  | 'attendee_pending'
  | 'attendee_declined'
  | 'attendee_reschedule'
  | 'attendee_cancellation'
  | 'attendee_reminder'
  | 'host_booked'
  | 'host_rescheduled'
  | 'host_cancelled'
  | 'host_declined'
  | 'host_reminder'
  | 'follow_up';

export interface BookingMessages {
  booking: {
    selectTime: string;
    durationMinutes: string;
    timezoneLabel: string;
    timezone: string;
    noSlots: string;
    /** Config-error emptiness (public-safe: never names internals). */
    noTimesNow: string;
    /** External calendar unreachable (public-safe). */
    timesUnavailable: string;
    /** Said after "Try again" asked and the times still did not answer. */
    timesStillUnavailable: string;
    calendarUnavailableTitle: string;
    calendarUnavailableBody: string;
    book: string;
    confirm: string;
    confirming: string;
    confirmed: string;
    requested: string;
    awaitingConfirmation: string;
    confirmationSentTo: string;
    yourName: string;
    yourEmail: string;
    invalidEmail: string;
    requiredField: string;
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
    /**
     * Duplicate-booking guard (#69 / AB1). Its own block, and its own card on
     * the booking page: a `DUPLICATE_BOOKING` is a 409 like a taken slot, but
     * the block is on the address rather than the time, so `slotTaken` +
     * `pickAnother` would send the booker to do the one thing that cannot
     * help. `body` names NO date, time or host — see `duplicate-guard.ts`.
     */
    duplicateGuard: {
      title: string;
      body: string;
      changeEmail: string;
    };
    /**
     * One-off links (#69 / AB2, #110) — the PUBLIC half, shown to the invitee
     * who opens a link that is already spent.
     *
     * Its own block rather than more keys on `duplicateGuard`, because the two
     * say different things to different people: AB1's card tells a booker their
     * address already has a booking, this one tells a person their invite link
     * has been used. There is no retry and no "pick another": nothing the
     * invitee can do here resolves it, so the copy sends them to the organizer
     * instead of offering an action that cannot work.
     *
     * Says nothing about WHY it is dead. Consumed and revoked are one state to
     * an invitee, and "the organizer cancelled this link" is a message about
     * the host's intentions that the host may not want relayed.
     */
    oneOffLink: {
      usedTitle: string;
      usedBody: string;
    };
  };
  /**
   * The three-region public event page (BP): event panel, month calendar, day
   * column. Its own block rather than more keys on `booking`, because these
   * words belong to the LAYOUT — region names, month navigation, the 12h/24h
   * toggle — while `booking` owns the flow (pick, hold, confirm, fail) that
   * runs inside it and is also used by surfaces with no calendar at all.
   */
  bookingPage: {
    /** Landmark names, read by a screen reader as it moves between regions. */
    detailsRegion: string;
    calendarRegion: string;
    timesRegion: string;
    /** The attendee form's landmark, once a time has been chosen. */
    yourDetails: string;
    /** Term for the team scheduling method shown in the panel. */
    method: string;
    previousMonth: string;
    nextMonth: string;
    /** Marks the current day in the grid; visually a dot, here for the label. */
    today: string;
    /** The day column before any day is chosen. */
    pickADay: string;
    /** Announced (not shown) while the month's times are still being read. */
    readingTimes: string;
    /** A chosen day that turns out to have nothing bookable on it. */
    noTimesOnDay: string;
    /** Heading over the day column: "Times on Mon, Sep 14". */
    timesOn: string;
    timeFormat: string;
    hour12: string;
    hour24: string;
    /** Label for the duration chip (one duration today, a selector later). */
    duration: string;
    /** Leaves the filled-in form and goes back to the slot list. */
    backToTimes: string;
    /** Opens the rest of a long event description, which is clamped so that a
     *  host who writes an essay cannot push the duration and the timezone below
     *  the fold. */
    descriptionMore: string;
    descriptionLess: string;
    /** The phone's way back from a day's times to the month. */
    backToCalendar: string;
    /** The 4px progress track's accessible name: "Step 2 of 4". */
    progress: string;
    /** Term names for the confirmation's facts, read by a screen reader only. */
    what: string;
    when: string;
    who: string;
    /** The confirmation's first action: download the booking as a calendar file. */
    addToCalendar: string;
    /** The unit beside a duration set as a figure on the profile ("30 min"). */
    minutesUnit: string;
    /** The zone picker's sticky group labels: the zone the times are shown in,
     *  the visitor's own zone when it differs, then every zone. */
    zoneCurrent: string;
    zoneLocal: string;
    zoneAll: string;
    /** The event panel's time zone fact: the HOST's zone, said as theirs. */
    hostTimeZone: string;
    /** The quiet link under a short day's times: "Next day with times: Tue, Oct 13". */
    nextTimes: string;
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
    /** The pending-request variants: the host has not confirmed it yet. */
    cancelThisRequest: string;
    cancelRequest: string;
    requestCancelled: string;
    noOpenTimes: string;
    joinMeeting: string;
    /** Appended to the join link for screen readers. It opens in a new tab, and
     *  saying so is the whole point — so it cannot be hardcoded English on a
     *  page whose locale comes from the invitee's own link. */
    joinMeetingOpensNewTab: string;
    /** Shown in place of the date line when the booking's start instant did not
     *  parse — a readable line instead of a thrown render (#123). */
    timeUnreadable: string;
    /** Shown when the manage link no longer opens a booking — usually because
     *  the token rotated on an earlier reschedule (#123). */
    linkInvalidTitle: string;
    linkInvalidBody: string;
  };
  /**
   * What a visitor reads when something on our side gets in the way: the
   * service too busy to answer (a 429), a calendar that cannot be read just
   * now, a request that did not go through. Short and honest, and each one
   * says what to do next. Never an internal name, a status code or a vendor.
   */
  trouble: {
    /** A page the service was too busy to serve (429). It retries on its own. */
    busyTitle: string;
    busyBody: string;
    /** The countdown to the automatic retry: "{seconds}" is a whole number. */
    busyRetrying: string;
    /** After the automatic retries ran out. */
    busyStill: string;
    tryAgain: string;
    /** The month's times could not be read because the service was busy. */
    busyTimes: string;
    /** A hold on the picked time was refused; the booking can still go ahead. */
    holdBusy: string;
    holdUnconfirmed: string;
    holdGone: string;
    holdFailed: string;
    /** Shown above Confirm when a booking did not go through; the form is kept. */
    bookBusy: string;
    bookFailed: string;
    /** The manage page's reschedule and cancel outcomes. */
    actionBusy: string;
    actionCalendar: string;
    actionTaken: string;
    actionUnavailable: string;
    actionLinkDead: string;
    actionFailed: string;
    pickTime: string;
    /** In place of the manage page's picker when its times could not be read. */
    manageTimesUnavailable: string;
    manageTimesBusy: string;
    /** The public error boundaries: the page itself failed to load. */
    pageTitle: string;
    pageBody: string;
    manageTitle: string;
    manageBody: string;
  };
  /** Growth loop — public-page attribution badge + confirmation signup CTA. */
  growth: {
    madeWith: string;
    /** The one short line above the free-calendar button. It names the product
     *  once; the "Made with" badge below is the only other mention. */
    ctaLine: string;
    /** The button under a confirmation and at the foot of a profile. */
    ctaButton: string;
    /** Screen-reader suffix: the button opens a new tab. */
    ctaOpensNewTab: string;
    /** SEO/OG meta descriptions for the public pages (host/event data only). */
    seoProfile: string;
    seoEvent: string;
    /** An event page's title, as its link preview says it. */
    seoEventTitle: string;
    /** The button drawn on a link preview card. */
    shareCardCta: string;
  };
  /** Public landing pages — the host profile and the team entry page (#141). */
  landing: {
    /** Header line under the team name on the team landing page. */
    timesIn: string;
    /** Empty state on the host landing page. */
    noEvents: string;
    /** Empty state on the team landing page. */
    noTeamEvents: string;
  };
  /**
   * The site itself, before any page names itself: the default `<title>` and
   * description every page inherits, and the page a link that leads nowhere
   * lands on. `{product}` is the deployment's product name, so a fork that
   * keeps the neutral default reads just as well as Dapta's own build.
   */
  site: {
    title: string;
    description: string;
    notFoundTitle: string;
    notFoundBody: string;
    notFoundHome: string;
    /** The root page of a fork running the local sign-in (Dapta's build sends
     *  `/` straight to the app): what this is, and the seeded demo page. */
    devLandingTitle: string;
    devLandingBody: string;
    devLandingCta: string;
    /** Before the demo page's path, which renders as code after it. */
    devLandingTry: string;
  };
  /**
   * Location kind labels — WHERE a meeting happens. Shared by the public
   * booking page, the manage page and the event-type editor so one kind reads
   * the same everywhere. No conferencing vendor is named (R15); the running
   * product may override `conferencing` with a runtime label (ADR 0008).
   */
  location: {
    whereLabel: string;
    conferencing: string;
    inPerson: string;
    phone: string;
    custom: string;
  };
  /** Team scheduling method names (the FREE layer competitors paywall). */
  scheduling: {
    round_robin: string;
    collective: string;
    fixed_round_robin: string;
    /** Short one-line descriptions for the event-type editor selector. */
    round_robin_hint: string;
    collective_hint: string;
    fixed_round_robin_hint: string;
    /**
     * Round robin's distribution method (`rrDistribution`), as Calendly names
     * the choice: `availability` is today's behavior, `equal` counts only this
     * event's bookings and holds back a host 3 or more ahead.
     */
    distribution: string;
    availability: string;
    availability_hint: string;
    equal: string;
    equal_hint: string;
  };
  /** Themed timezone combobox (QA2 fix 1) — shared by public + admin surfaces. */
  tzPicker: {
    search: string;
    noResults: string;
  };
  /** Phone field with country selector (QA3 fix 2). */
  phonePicker: {
    search: string;
    noResults: string;
    invalid: string;
    countryLabel: string;
  };
  /**
   * Generic token-styled listbox (`Select`, reskin slice P) — a sibling of
   * `tzPicker`/`phonePicker`: a shared primitive that owns its OWN copy, so a
   * caller never threads these two strings through. Only the search affordance
   * needs words; the options are the caller's.
   */
  select: {
    search: string;
    noResults: string;
  };
  /** Generic dialog actions — the `ConfirmDialog` defaults (reskin slice P). */
  dialog: {
    confirm: string;
    cancel: string;
  };
  /** Admin dashboard surface (F8 parity). Reuses the same catalog/locale mechanism. */
  admin: {
    nav: {
      home: string;
      bookings: string;
      availability: string;
      eventTypes: string;
      teams: string;
      calendars: string;
      settings: string;
      bookingPage: string;
      /** The rail's prominent item: the guide that connects an AI app with the person's account. */
      connect: string;
      /** What a connected agent can do, in plain words. */
      tools: string;
      /** The quiet group for builders: API keys, webhooks and the API docs. */
      api: string;
      /** The product documentation, an EXTERNAL link (see `lib/docs-url.ts`). */
      docs: string;
      /** The door to the wider platform, EXTERNAL, only with NEXT_PUBLIC_PLATFORM_URL. */
      agents: string;
    };
    /** The pages under the rail's "API and webhooks" group, in its accordion and its flyout. */
    developerNav: {
      keys: string;
      webhooks: string;
      docs: string;
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
      /** The profile button at the foot of the rail, and the menu it opens. */
      accountMenu: string;
      language: string;
      collapse: string;
      expand: string;
      /** A dashboard page for something this workspace does not have (a deleted
       *  event type, team or schedule, or a mistyped address). */
      notFoundTitle: string;
      notFoundBody: string;
      /** A2 (#112) — screen-reader suffix on every icon-only link that opens a
       *  new tab. The icon says it visually; this says it out loud. */
      opensNewTab: string;
      /** The mobile top bar's menu button, and the name of the nav it opens. */
      openNav: string;
      primaryNav: string;
      /**
       * The operator account picker at the top of the rail (operator staff
       * only). `trigger` takes `{name}`, `listed` takes `{count}`.
       */
      accountSwitcher: {
        label: string;
        trigger: string;
        search: string;
        noMatch: string;
        loadMore: string;
        searching: string;
        listed: string;
        denied: string;
        failed: string;
      };
      switcher: {
        trigger: string;
        menuLabel: string;
        eyebrow: string;
        comingSoon: string;
        opensNewTab: string;
        forms: string;
      };
      /** Product theme switch (rail footer). Both strings name the DESTINATION,
       *  not the current state — a control reading "Dark" is ambiguous about
       *  whether that is where you are or where you are going. */
      theme: {
        toLight: string;
        toDark: string;
      };
    };
    home: {
      welcome: string;
      welcomeNamed: string;
      subtitle: string;
      bookingLink: string;
      /** CopyLink button labels (booking-link card). */
      copy: string;
      copied: string;
      open: string;
      statEventTypes: string;
      statUpcoming: string;
      statTeams: string;
      createEvent: string;
      createEventDesc: string;
      setAvailability: string;
      setAvailabilityDesc: string;
      stylePage: string;
      stylePageDesc: string;
      /** "Get bookable" first-run checklist (F1 §2 — driven by real setup status). */
      setupTitle: string;
      setupSubtitle: string;
      setupConnectTitle: string;
      setupConnectDesc: string;
      setupConnectAction: string;
      setupHoursTitle: string;
      setupHoursDesc: string;
      setupHoursAction: string;
      setupEventTitle: string;
      setupEventDesc: string;
      setupEventAction: string;
      setupDone: string;
      /** The banner at the top of the home: run the calendar from an AI agent. */
      agentBanner: {
        title: string;
        body: string;
        cta: string;
      };
      /**
       * The big "Connect your agent" card: a prompt typed into an AI app and
       * the meeting it books, cycling through `prompts` and the apps.
       * `{product}` is filled on the server.
       */
      agentCard: {
        eyebrow: string;
        title: string;
        body: string;
        cta: string;
        /** Accessible name of the animation. */
        label: string;
        /** What the user asks, one per turn. Written for a person, not a parser. */
        prompts: string[];
        /** The app's answer once the calendar changed. */
        done: string;
        /** The composer's placeholder before the prompt starts. `{app}` */
        placeholder: string;
        connected: string;
        /** The demo's pause button: its name, and its tooltip while paused. */
        pause: string;
        play: string;
      };
    };
    settings: {
      title: string;
      subtitle: string;
      general: string;
      bookingPage: string;
      members: string;
      notifications: string;
      /** Tab label. The tab's own copy lives at `admin.integrations`. */
      integrations: string;
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
      locationNone: string;
      locationDetailAddress: string;
      locationDetailPhone: string;
      locationDetailCustom: string;
      locationConferencingHint: string;
      locationNoDestinationWarning: string;
      /** Team events only: one location for every host. Round robin: the
       *  link comes from the assigned host's calendar for new events. */
      locationTeamConferencingHint: string;
      /** Collective and fixed round robin: several hosts are on each booking,
       *  and the link comes from one of their calendars. */
      locationTeamSharedConferencingHint: string;
      /** `{names}` is one host with no calendar set to receive new events. */
      locationTeamNoDestinationOne: string;
      /** `{names}` is a list of them, joined for the language ("A and B"). */
      locationTeamNoDestinationMany: string;
      /** Collective: no host has one, so no booking gets a link. */
      locationTeamNoDestinationAll: string;
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
      /**
       * Duplicate-booking guard (#69 / AB1) — the editor half. Never call it a
       * rate limit or an abuse control in either locale: it counts an email
       * nobody verifies, so it prevents accidents (CONTEXT.md).
       */
      duplicateGuard: {
        label: string;
        hint: string;
      };
      /**
       * One-off links (#69 / AB2, #110) — the editor half.
       *
       * Never call it a security control in either locale: it stops a link
       * pasted to one person being forwarded and re-used, and it authenticates
       * nobody (the per-IP limiter is the security control). Same framing rule
       * as `duplicateGuard` above.
       *
       * `publicWarning` is requirement 4 of #110 and it is COPY PLUS A
       * CONDITION, never a block: a link over a publicly bookable event limits
       * nothing, and the host has to learn that where they mint it rather than
       * from a doc — but they may have a reason, so nothing is disabled.
       */
      oneOffLinks: {
        title: string;
        hint: string;
        mint: string;
        minted: string;
        /** Minting copies the new link too — one toast reports both. */
        copiedOnMint: string;
        copy: string;
        copied: string;
        revoke: string;
        revoked: string;
        empty: string;
        saveFirst: string;
        publicWarning: string;
        stateLive: string;
        stateConsumed: string;
        stateRevoked: string;
        /** `{date}` — when it was minted. */
        createdAt: string;
        failed: string;
      };
      intakeQuestions: string;
      /** Reorder + reserved-name hard block (QA3 fixes 3, 6). */
      moveUp: string;
      moveDown: string;
      reservedBlocked: string;
      /** Phone questions: which country the selector starts on (QA4 fix 1b). */
      defaultCountryLabel: string;
      /** Per-row quick actions + team section on the Events list (QA3 fix 4). */
      openPublic: string;
      copyLink: string;
      linkCopied: string;
      toggleVisible: string;
      eventShown: string;
      eventHidden: string;
      teamEventsSection: string;
      /** Built-in booking-page fields shown locked in the intake editor (QA2 fix 7). */
      fixedFieldsHint: string;
      fixedName: string;
      fixedEmail: string;
      fixedNotes: string;
      alwaysAsked: string;
      reservedWarning: string;
      namePlaceholder: string;
      labelPlaceholder: string;
      req: string;
      addQuestion: string;
      saved: string;
      saveChanges: string;
      createEventType: string;
      saving: string;
      /** Team scheduling section (team events only). */
      schedulingMethod: string;
      hostsTitle: string;
      priority: string;
      /** Round robin: who a booking goes to, said under the Hosts title. */
      priorityHint: string;
      /**
       * A host's priority, picked from five levels stored as -2..2. Medium is
       * 0, the value every host starts with. `custom` names a value outside
       * -2..2 (set through the API), kept until someone picks a level; `{n}`
       * interpolates it.
       */
      priorityLevels: {
        lowest: string;
        low: string;
        medium: string;
        high: string;
        highest: string;
        custom: string;
      };
      weight: string;
      fixedHost: string;
      fixedHostHint: string;
      /** The read-only "which calendar is this linked to" line (Felipe:
       *  "cómo está el calendario conectado al evento, esto no hace sentido"). */
      calendarLinkManage: string;
      /** {calendar} interpolates the connection label (e.g. an email). */
      calendarLinkBoth: string;
      calendarLinkWriteOnly: string;
      /** {n} interpolates the conflict-checked calendar count. */
      calendarLinkConflictsOnly: string;
      calendarLinkNoDestination: string;
      calendarLinkNone: string;
      calendarLinkConnect: string;
      /** PHASE 2 — the editable "Calendars for this event" section (personal
       *  events only; replaces the old read-only calendarLink* notice above). */
      calendarsSectionTitle: string;
      calendarsSectionHint: string;
      calendarsCheckConflicts: string;
      calendarsAddEventsHere: string;
      calendarsManageLink: string;
      /**
       * Who hosts an event, said where the editor's Hosts block sits. A
       * personal event has no hosts to add, so it points at team events
       * instead; a team event's hosts are its team's members when it is saved,
       * managed on the team page. `{team}` interpolates the team name.
       */
      teamHosts: {
        personalHint: string;
        newEventFor: string;
        createTeam: string;
        everyMember: string;
        manageOnTeamPage: string;
        /**
         * Hosts who cannot take a booking yet: no working hours (an invited
         * member until their first sign-in). `{names}` is the joined list.
         * The collective variant: everyone attends, so nobody can book.
         */
        noHours: string;
        noHoursCollective: string;
        /** Hosts with no calendar connected: still booked, busy times unchecked, no calendar of their own written. */
        noCalendar: string;
      };
      /** R (#91) — reminders + follow-up, owned by the event type (#68). */
      reminders: {
        sectionTitle: string;
        sectionHint: string;
        beforeMeeting: string;
        afterMeeting: string;
        addReminder: string;
        /** {max} interpolates the per-event cap. */
        capReached: string;
        sendLabel: string;
        unitMinutes: string;
        unitHours: string;
        unitDays: string;
        beforeStart: string;
        afterEnd: string;
        subjectLabel: string;
        bodyLabel: string;
        defaultCopyHint: string;
        remove: string;
        followUpHint: string;
        variablesLabel: string;
        formVariablesLabel: string;
        noFormVariables: string;
        /** {tokens} interpolates the dangling `{{form.*}}` variables. */
        danglingWarn: string;
        enabledLabel: string;
        noReminders: string;
      };
      /**
       * H2 (#108) — the intake-question → CRM contact property mapping section.
       * Never call a mapped write a "sync": it is one-directional, and it
       * OVERWRITES the property on every accepted booking (ADR 0005).
       */
      crmMapping: {
        sectionTitle: string;
        /** {provider} interpolates the CRM's own name. */
        sectionHint: string;
        /** The read-only identity row, and why it is shown rather than absent. */
        identityTitle: string;
        identityHint: string;
        identityEmail: string;
        identityFirstName: string;
        identityLastName: string;
        /** Empty states. */
        notConnectedTitle: string;
        notConnectedBody: string;
        notConnectedLink: string;
        unavailable: string;
        noProperties: string;
        /** The table itself. */
        sourceLabel: string;
        propertyLabel: string;
        sourcePlaceholder: string;
        propertyPlaceholder: string;
        addMapping: string;
        removeMapping: string;
        addTarget: string;
        noMappings: string;
        /** {max} interpolates the per-event cap. */
        capReached: string;
        /** Source group headings in the source picker. */
        groupQuestions: string;
        groupAttendee: string;
        groupEvent: string;
        /** Attendee + event metadata source names. */
        attendeePhone: string;
        attendeeNotes: string;
        attendeeTimeZone: string;
        attendeeLanguage: string;
        eventTypeTitle: string;
        eventStart: string;
        eventLength: string;
        eventHostName: string;
        eventHostEmail: string;
        /** Enumeration reconciliation, shown at configure time. */
        optionsMatch: string;
        /** {matched}, {total} and {values} interpolate the diff. */
        optionsPartial: string;
        optionsNone: string;
        /** A stored target the portal no longer has. */
        missingProperty: string;
        /** A stored target that exists but no longer fits this answer's type. */
        incompatibleProperty: string;
        /** The mapped QUESTION was deleted or renamed; the row is dropped on save. */
        missingQuestion: string;
        /** Actions. */
        refresh: string;
        refreshing: string;
        suggest: string;
        suggestNone: string;
        /** {n} interpolates how many rows were pre-filled. */
        suggestFilled: string;
        suggestNotSaved: string;
        /** The never-create rule, as the picker's empty hint. */
        createInProviderHint: string;
      };
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
      /** A2 (#112) — the delete confirmation, as a real dialog. The inline
       *  yes/no pair it replaces never trapped focus and never announced the
       *  question it was asking. */
      deleteTitle: string;
      deleteBody: string;
      removeOverride: string;
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
      loadingSlots: string;
      dateTimeHost: string;
      attendeeName: string;
      attendeeEmail: string;
      attendeeTimezone: string;
      pickTime: string;
      /** DateTimePicker status bar (QA2 fix 8): both halves shown, missing one flagged. */
      pickerDate: string;
      pickerTime: string;
      pickerMissing: string;
      pickDateTime: string;
      /** "Times shown in {tz}" lead on the bookings list (QA2 fix 8c). */
      timesShownIn: string;
      /** Unified questions block on the manual-booking form (QA3 fix 6a). */
      questionsTitle: string;
      creating: string;
      createBooking: string;
      createdTitle: string;
      createdNote: string;
      backToBookings: string;
      /** A booking's own page, for a uid this workspace does not have (the same for one that does not exist). */
      notFoundTitle: string;
      notFoundBody: string;
      newSubtitle: string;
      createEventFirst: string;
      slotTaken: string;
      noHandleNotice: string;
      noHandleLink: string;
      /** Actionable config-error notices (admin-only detail; one link each). */
      scheduleMissingNotice: string;
      scheduleMissingLink: string;
      noHoursNotice: string;
      noScheduleNotice: string;
      eventQuestions: string;
      availabilityLink: string;
      /** One-click fix for NO_SCHEDULE — creates + links working hours inline. */
      createWorkingHours: string;
      creatingWorkingHours: string;
      calendarUnavailableNotice: string;
      calendarUnavailableLink: string;
      calendarUnavailableBooking: string;
      slotsLoadError: string;
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
      /**
       * Destructive-confirmation copy for the `ConfirmDialog` (reskin slice P).
       * The inline two-button confirm this replaced asked nothing — it just
       * swapped the Delete button out — so a real dialog needs a question and a
       * consequence. `{name}` interpolates the team / member.
       * Deleting a team is API-guarded against orphaned event types (409), so
       * the body deliberately does NOT claim they go with it.
       */
      deleteTitle: string;
      deleteBody: string;
      removeTitle: string;
      removeBody: string;
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
      newTeamEvent: string;
      inviteTitle: string;
      inviteLead: string;
      emailLabel: string;
      emailPlaceholder: string;
      emailInvalid: string;
      sendInvite: string;
      ownerLock: string;
      memberPending: string;
      noAccountMember: string;
      inviteFromMembers: string;
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
      /** Label while a picked photo is being decoded and downscaled. */
      imageWorking: string;
      /** Opened fine, but nothing storable came out — a vector too big to keep
       *  verbatim. Never names the 25MB input cap, which is not the problem. */
      imageCannotShrink: string;
      creating: string;
      backToTeamsList: string;
      imageReadError: string;
      nameHelp: string;
      slugHelp: string;
      bioHelp: string;
      logoHelp: string;
    };
    /** Members / Staff — the workspace roster (account roles owner/admin/member). */
    members: {
      title: string;
      subtitle: string;
      rosterLabel: string;
      /** What each role can do (QA3 fix 5) — one line per role under the title. */
      rolesHintOwner: string;
      rolesHintAdmin: string;
      rolesHintMember: string;
      invite: string;
      inviteTitle: string;
      inviteLead: string;
      emailLabel: string;
      emailPlaceholder: string;
      emailInvalid: string;
      emailTaken: string;
      roleLabel: string;
      roleOwner: string;
      roleAdmin: string;
      roleMember: string;
      sendInvite: string;
      cancel: string;
      you: string;
      noEmail: string;
      statusActive: string;
      statusInvited: string;
      statusDisabled: string;
      enable: string;
      disable: string;
      remove: string;
      ownerLock: string;
      lastOwnerTitle: string;
      /** Single-owner model (QA2 fix 6b): explicit transfer flow. */
      transferOwnership: string;
      transferConfirm: string;
      /** A2 (#112) — both destructive asks move onto ConfirmDialog. */
      removeTitle: string;
      removeBody: string;
      transferTitle: string;
      transferBody: string;
      ownershipTransferred: string;
      roleUpdated: string;
      statusUpdated: string;
      memberInvited: string;
      /** The invite went in, but this deployment sends no email: say so instead of "sent". */
      memberAddedNoEmail: string;
      /** The invite went in, but its email could not be queued. */
      inviteEmailFailed: string;
      inviteLimit: string;
      resendInvite: string;
      inviteResent: string;
      resendNoEmail: string;
      resendTooSoon: string;
      memberRemoved: string;
      genericError: string;
      noAccessTitle: string;
      noAccessBody: string;
    };
    /** The accounts one person can act in (rail switcher), for anyone with two or more. */
    workspaces: {
      menuLabel: string;
      current: string;
      pending: string;
      switchFailed: string;
    };
    /** `/invite/{code}` when the signed-in person holds no invitation to that workspace. */
    invite: {
      pageTitle: string;
      joinTitle: string;
      joinBody: string;
      join: string;
      joining: string;
      joinFailed: string;
      notNow: string;
      /** The same page for someone already in the workspace. */
      openTitle: string;
      openBody: string;
      open: string;
      notForYouTitle: string;
      notForYouBody: string;
      otherEmail: string;
      goHome: string;
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
      /** The "which account?" step shown before starting the OAuth popup. */
      emailStepTitle: string;
      emailStepLabel: string;
      emailStepHelp: string;
      emailStepContinue: string;
      emailStepBack: string;
      connectWaiting: string;
      connectHint: string;
      connectDone: string;
      connectSuccess: string;
      connectCancelled: string;
      connectFailed: string;
      /** In-flight label on "I've finished connecting" — an explicit check must
       *  always change something on screen, so it says it is working. */
      connectChecking: string;
      /** The check ran and the connection is not there. Names the provider AND
       *  the account being looked for: the usual real cause is that a different
       *  account was authorized than the one typed at the email step. */
      connectNotSeenYet: string;
      /** Two failed manual checks in a row — stop waiting and say why. */
      connectGaveUp: string;
      /** The check could not run at all (transport, or a server error whose own
       *  message is raw English and must not be shown). */
      connectCheckFailed: string;
      popupBlocked: string;
      destination: string;
      conflictCheck: string;
      disconnect: string;
      disconnectError: string;
      /** A2 (#112) — disconnecting stops conflict checks and write-out, so it asks. */
      disconnectTitle: string;
      disconnectBody: string;
      /** Muted fallback label when a connection's account email couldn't be
       *  determined (never repeats the provider name — see connectionLabel). */
      accountUnknown: string;
      healthSyncing: string;
      healthRecorded: string;
      yourCalendars: string;
      connectAnother: string;
      addEventsHere: string;
      addEventsHereHelp: string;
      checkForConflicts: string;
      checkForConflictsHelp: string;
      summaryDestination: string;
      summaryNoDestination: string;
      summaryConflictsNone: string;
      summaryConflictsOne: string;
      summaryConflictsMany: string;
      healthChecking: string;
      healthOk: string;
      healthError: string;
      recheck: string;
      /** Persisted-health caption: {time} interpolates the last probe time. */
      lastChecked: string;
      neverChecked: string;
      emptyTitle: string;
      emptyBody: string;
      emptyConflicts: string;
      emptyDestination: string;
      /** {email} interpolates the already-connected account for that provider. */
      alreadyConnectedWithEmail: string;
      alreadyConnectedNoEmail: string;
      connectedPageTitle: string;
      connectedPageBody: string;
      connectedPageClose: string;
      connectedPageErrorTitle: string;
      connectedPageErrorBody: string;
      /** The "Test / Run check" self-test — the trust-building proof that
       *  conflict-checking actually reads the host's real calendar. */
      testButton: string;
      testRunning: string;
      /** {n} interpolates the busy-event count read in the next 14 days. */
      testOkConflictsOn: string;
      testOkConflictsOff: string;
      testFailDisconnected: string;
      testFailNotReady: string;
      testFailReadFailed: string;
      testReconnect: string;
    };
    login: {
      title: string;
      subtitle: string;
      continue: string;
      footnote: string;
      emailLabel: string;
      emailPlaceholder: string;
      emailInvalid: string;
      workosCta: string;
      workosSubtitle: string;
      error: string;
      retry: string;
    };
    /**
     * The identity service could not be reached while renewing a session
     * (#114). Distinct from `login.error` on purpose: nothing is wrong with the
     * person's credentials and they are still signed in, so the copy must not
     * imply they need to sign in again.
     */
    session: {
      unavailableTitle: string;
      unavailableBody: string;
      retry: string;
      /** The way out when the failure turns out not to be transient. */
      signOut: string;
    };
    settingsGeneral: {
      displayName: string;
      publicHandle: string;
      timezone: string;
      saved: string;
      save: string;
      saving: string;
    };
    /** Settings → General: the account's Dapta branding switch (included with Dapta AI). */
    brandingSetting: {
      title: string;
      hint: string;
      switchLabel: string;
      /** Not entitled: the sentence, linked to the Dapta AI app when the deployment names it. */
      included: string;
      /** Off, but the subscription lapsed: the stored choice shows greyed. */
      lapsed: string;
      membersReadOnly: string;
      chipShowing: string;
      chipHidden: string;
      chipShowingAgain: string;
      saved: string;
      saveFailed: string;
    };
    notifications: {
      title: string;
      subtitle: string;
      attendeeSection: string;
      attendeeSectionDesc: string;
      hostSection: string;
      hostSectionDesc: string;
      labels: Record<NotificationEmailKey, string>;
      descriptions: Record<NotificationEmailKey, string>;
      customizedBadge: string;
      editTemplate: string;
      updated: string;
      updateFailed: string;
      editorSubject: string;
      editorBody: string;
      variables: string;
      variablesHint: string;
      unknownTokensWarn: string;
      preview: string;
      usingDefault: string;
      usingCustom: string;
      reset: string;
      resetDone: string;
      /** A2 (#112) — reset throws away copy the host wrote, so it asks first. */
      resetTitle: string;
      resetBody: string;
      save: string;
      saving: string;
      saved: string;
      saveFailed: string;
      back: string;
    };
    developer: {
      /** What this page is FOR (QA2 fix 4) — plain-language leads per section. */
      pageLead: string;
      apiKeysLead: string;
      webhooksLead: string;
      apiKeys: string;
      noKeys: string;
      revoke: string;
      /** A2 (#112) — revoking a key and deleting a webhook were one click each. */
      revokeTitle: string;
      revokeBody: string;
      deleteWebhookTitle: string;
      deleteWebhookBody: string;
      deliveryOk: string;
      deliveryFailed: string;
      revoked: string;
      copyOnce: string;
      name: string;
      scopes: string;
      createKey: string;
      webhooks: string;
      noWebhooks: string;
      /** Shown once with a new webhook's signing secret (W / #75). */
      webhookSecretCopyOnce: string;
      /** This deployment has no encryption key, so no secret can be stored. */
      webhookNoKeyError: string;
      subscriberUrl: string;
      events: string;
      /** The webhook form's event checkboxes, by the wire name after `booking.` (the wire name itself is never translated). */
      webhookEventLabels: Record<string, string>;
      addWebhook: string;
      ping: string;
      deliveries: string;
      noDeliveries: string;
      /** In-flight labels — these two replace a bare ellipsis (A2, #112). */
      creating: string;
      loading: string;
      delete: string;
      active: string;
      cancel: string;
      genericError: string;
      revokedToast: string;
      deletedToast: string;
      toggledToast: string;
      copy: string;
      copied: string;
      /** What a scope lets a key do, in the create form and the skill zip's tool table. */
      kindRead: string;
      kindWrite: string;
      kindDestructive: string;
      toolNeedsNoKey: string;
      toolNeedsAnyKey: string;
      toolOrPublic: string;
      toolDescriptions: Record<string, string>;
      scopeLabels: Record<string, string>;
      scopesLead: string;
      eventTypesLabel: string;
      eventTypesAll: string;
      eventTypesOnly: string;
      expiryLabel: string;
      expiryNever: string;
      expiryDays: string;
      keyScopesUnknown: string;
      keyAllEventTypes: string;
      keyOnlyEventTypes: string;
      keyNoExpiry: string;
      keyExpires: string;
      keyExpired: string;
      keyLastUsed: string;
      keyNeverUsed: string;
      apiRefTitle: string;
      apiRefLead: string;
      apiDocs: string;
      apiOpenApi: string;
      apiRefMissing: string;
      /** Connected apps: OAuth grants with revoke. */
      connectedTitle: string;
      connectedLead: string;
      connectedNone: string;
      connectedUnnamed: string;
      connectedFrom: string;
      connectedApprovedBy: string;
      connectedSince: string;
      connectedLastUsed: string;
      connectedNeverUsed: string;
      connectedRevoke: string;
      connectedRevokeTitle: string;
      connectedRevokeBody: string;
      connectedRevokedToast: string;
      connectedExpiryNote: string;
      /** The API docs page's lead (the API keys page uses `pageLead`). */
      docsPageLead: string;
      /**
       * On the API keys page: the way in for an agent without MCP, a zip that
       * teaches it the REST API. `{product}` is the product's name. The
       * unavailable line replaces the button when the installation has no
       * public API address to write into the skill.
       */
      guideSkillTitle: string;
      guideSkillBody: string;
      guideSkillButton: string;
      /** The button while the zip is being built. */
      guideSkillPending: string;
      guideSkillUnavailable: string;
      /**
       * A download that failed, by the route's `error` code: the session ended,
       * a member asked, or anything else (the network included). A missing
       * public address reuses `guideSkillUnavailable`.
       */
      guideSkillErrorSession: string;
      guideSkillErrorForbidden: string;
      guideSkillErrorGeneric: string;
    };
    /**
     * The connect page (/admin/developers/connect): connect an AI app to the
     * MCP by logging in to the person's account (OAuth), no key. The page
     * fills `{product}` (the connector's name, `CONNECTOR_NAME`), `{server}`
     * (the name the server is registered under) and `{count}` (the number of
     * tools) on the server; `{app}` and `{url}` stay for the guide. In step
     * bodies, `**text**` renders bold and text between backticks renders as
     * inline code. Product and button names inside other apps stay in
     * English, as those apps show them. Never names the identity provider.
     */
    connect: {
      /** The section's name above the heading, "MCP". */
      eyebrow: string;
      heading: string;
      intro: string;
      signinTitle: string;
      /** The tag beside the sign-in card's title. */
      recommended: string;
      signinIntro: string;
      benefits: {
        noKey: { title: string; body: string };
        workspaces: { title: string; body: string };
        /** Who can connect: owners and admins, with their own access. */
        access: { title: string; body: string };
      };
      /** Accessible name of the app tabs. */
      appsLabel: string;
      urlLabel: string;
      promptLabel: string;
      /** A first request to paste into the app: one that only reads. */
      prompt: string;
      copy: string;
      copied: string;
      copyFailed: string;
      copyUrl: string;
      copyCommand: string;
      copyConfig: string;
      copyPrompt: string;
      addToCursor: string;
      /**
       * The way into each app from its first step, fitted to the device: a
       * web link for Claude and ChatGPT, Claude Desktop's own link on a
       * computer, a one-click copy of the add command for the CLIs, and on a
       * phone a note for what only a computer can do. `{app}` in `phoneNote`.
       */
      open: {
        claude: string;
        claudeDesktop: string;
        /** The button to the connector's page in Claude's connectors directory. */
        claudeDirectory: string;
        /** Read out after a button that opens another site in a new tab. */
        newTab: string;
        chatgpt: string;
        copyCommand: string;
        copied: string;
        pasteHint: string;
        phoneNote: string;
      };
      /** One numbered list per app, in the order the app asks for things. */
      apps: {
        claude: { steps: { title: string; body: string }[] };
        /**
         * Claude where the connector is listed in its connectors directory
         * (`MCP_CLAUDE_DIRECTORY_URL`, or a known listing for the MCP
         * address): the listing first, the custom connector folded under it
         * for organizations that turned the directory off.
         */
        claudeDirectory: { steps: { title: string; body: string }[]; fallbackTitle: string; fallbackBody: string };
        chatgpt: { steps: { title: string; body: string }[] };
        /** `directoryTitle`/`directoryBody`: the card above the steps when the directory listing is on. */
        claudeCode: { steps: { title: string; body: string }[]; note: string; directoryTitle: string; directoryBody: string };
        codex: { steps: { title: string; body: string }[]; note: string };
        cursor: { steps: { title: string; body: string }[] };
        openclaw: { steps: { title: string; body: string }[] };
        hermes: { steps: { title: string; body: string }[] };
      };
      /** Under the steps: one connector reaches every workspace. */
      tip: string;
      /**
       * Only where this API runs its own sign-in server: a new connection can
       * only read until the person approves writing too.
       */
      stepUpNote: string;
      unavailableTitle: string;
      unavailableBody: string;
      /** The animated walkthrough above the steps. */
      media: {
        /** `{app}` */
        terminalLabel: string;
        play: string;
        pause: string;
      };
      /**
       * The animated walkthroughs. `ui` is the CLIs' own output (Claude Code,
       * Codex, OpenClaw, Hermes), kept in English in both locales the way
       * those tools print it; `prompt`, `signIn` and `answer` are ours and
       * speak the reader's language.
       */
      walkthrough: {
        /** What the person types in the animation: a request that books a meeting. */
        prompt: string;
        ui: {
          ccWelcome: string;
          ccHelp: string;
          /** `{url}` */
          ccAdded: string;
          ccManage: string;
          needsAuth: string;
          authenticate: string;
          ccBrowser: string;
          ccAuthOk: string;
          codexAdded: string;
          codexAuthorize: string;
          codexLoggedIn: string;
          codexModel: string;
          called: string;
          working: string;
          ocSaved: string;
          ocLogin: string;
          ocLoggedIn: string;
          hmSaved: string;
          hmLogin: string;
          hmLoggedIn: string;
        };
        /** The sign-in the apps open: email, then the code by email. */
        signIn: {
          title: string;
          emailLabel: string;
          email: string;
          continue: string;
          checkEmail: string;
          codeSentTo: string;
          noCode: string;
          /** `{app}` */
          connected: string;
          /** `{app}` */
          consentTitle: string;
          redirectNote: string;
          warning: string;
          allow: string;
          cancel: string;
        };
        /** The agent's answer: the open times it found, then the meeting it booked. */
        answer: {
          found: string;
          /** The open times, as the host's calendar shows them; the second one is booked. */
          slots: string[];
          booked: string;
          meeting: string;
          when: string;
          calendar: string;
        };
      };
      /** The short card that points to the Tools page. `{count}` in `toolsIntro`. */
      toolsTitle: string;
      toolsIntro: string;
      toolsLink: string;
    };
    /**
     * The Tools page (/admin/developers/tools): what an agent can do in the
     * product, in plain words, grouped. `items` is keyed by the MCP tool's
     * name; a spec holds it to the server's catalog in both languages.
     * `{product}` and `{count}` are filled on the server.
     */
    tools: {
      title: string;
      intro: string;
      /** Before each example request. */
      askLabel: string;
      /** A group's size: `countOne` for a single tool, `count` (`{n}`) for more. */
      countOne: string;
      count: string;
      connectCta: string;
      groups: {
        availability: { title: string; body: string };
        booking: { title: string; body: string };
        holds: { title: string; body: string };
        bookings: { title: string; body: string };
        requests: { title: string; body: string };
        account: { title: string; body: string };
      };
      items: Record<string, { what: string; ask: string }>;
    };
    /**
     * The OAuth consent page (`/auth/consent`): an app asks to act on the
     * workspace. Client names are self-asserted, so the host it is identified
     * by is shown beside them, never instead.
     */
    oauthConsent: {
      pageTitle: string;
      heading: string;
      unnamed: string;
      identifiedAs: string;
      returnsTo: string;
      loopbackWarning: string;
      workspace: string;
      signedInAs: string;
      scopesLead: string;
      staysConnected: string;
      shortLived: string;
      approve: string;
      deny: string;
      working: string;
      notAdminTitle: string;
      notAdminBody: string;
      expiredTitle: string;
      expiredBody: string;
      errorBody: string;
    };
    /**
     * Integrations tab (H1b / #93) — connect one CRM credential per account.
     *
     * NOTE WHAT IS ABSENT: the required-scope names. They are provider
     * identifiers the host matches character-for-character on a checkbox in
     * someone else's UI, so they come from the adapter itself
     * (`CrmProvider.requiredScopes`, surfaced on the capabilities reply) rather
     * than from here. Putting them in a locale catalog would let the setup
     * instructions drift from what the adapter needs, and would invite a
     * translator to "translate" an identifier. Only the prose lives here.
     */
    integrations: {
      pageLead: string;
      loadError: string;
      hubspotName: string;
      hubspotDesc: string;
      /** Deployment states in which connecting cannot succeed (#93, story 20). */
      disabledTitle: string;
      disabledBody: string;
      noKeyTitle: string;
      noKeyBody: string;
      /** The probe itself failed — say that, never diagnose a cause we did not learn. */
      unknownTitle: string;
      unknownBody: string;
      statusConnected: string;
      statusUnhealthy: string;
      statusDisconnected: string;
      statusNotConnected: string;
      notConnectedBody: string;
      endingIn: string;
      lastChecked: string;
      neverChecked: string;
      disconnectedBody: string;
      unhealthyLead: string;
      unhealthyScopes: string;
      unhealthyKeepsCredential: string;
      unhealthyUnknown: string;
      connect: string;
      connecting: string;
      reconnect: string;
      disconnect: string;
      disconnecting: string;
      disconnectConfirm: string;
      disconnectNothingDeleted: string;
      confirmDisconnect: string;
      cancel: string;
      dialogTitle: string;
      dialogLead: string;
      scopesTitle: string;
      scopesLead: string;
      tokenLabel: string;
      tokenPlaceholder: string;
      tokenHelp: string;
      labelLabel: string;
      labelPlaceholder: string;
      labelHelp: string;
      errorRejected: string;
      errorMissingScopes: string;
      errorUnverified: string;
      errorNoKey: string;
      errorDisabled: string;
      errorGeneric: string;
      nothingStored: string;
      connectedToast: string;
      disconnectedToast: string;
    };
    /** The workspace brand kit screen. */
    brandKit: {
      title: string;
      statement: string;
      statusSet: string;
      statusUnset: string;
      logo: string;
      logoHint: string;
      accent: string;
      accentHint: string;
      canvas: string;
      canvasHint: string;
      font: string;
      corners: string;
      buttons: string;
      cardStyle: string;
      shapeHint: string;
      keepPageOwn: string;
      save: string;
      saving: string;
      saved: string;
      saveFailed: string;
      readOnly: string;
      preview: string;
      previewHint: string;
      howItWorks: string;
      howItWorksBody: string;
      updatedOn: string;
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
      /** The save was refused outright for size — an image already stored under
       *  the old cap is the only thing big enough to do it. */
      saveTooLarge: string;
      profile: string;
      brand: string;
      appearance: string;
      meetings: string;
      displayName: string;
      publicHandle: string;
      /** The compact shareable-link unit + vanity slug claim (short-links §5). */
      yourLink: string;
      linkCopy: string;
      linkCopied: string;
      linkOpen: string;
      vanityLabel: string;
      vanityHint: string;
      vanityIncluded: string;
      vanityIncludedLink: string;
      bio: string;
      tryHandle: string;
      accent: string;
      contrast: string;
      /** Shown under the accent field when the host's colour falls below the
       *  3:1 non-text floor against the canvas their page paints on. It never
       *  blocks a save: ADR 0004's amendment informs, it does not override. */
      lowContrast: string;
      photoAvatar: string;
      /** Shown under the photo field when it is empty and a connected calendar
       *  account has one — so the host knows where the face on their page comes
       *  from, and that uploading their own replaces it. */
      photoFromConnectedAccount: string;
      /** The host removed the connected account's photo from their page. */
      connectedPhotoHidden: string;
      removeConnectedPhoto: string;
      useConnectedPhoto: string;
      coverImage: string;
      custom: string;
      customizeAppearance: string;
      /** One click to the look a new host is born with (ink on paper, the
       *  minimal set). Previewed first, applied on Save, revertible once. */
      newLook: string;
      newLookHint: string;
      /** Said while the new look is in the preview but not saved yet. */
      newLookPreviewing: string;
      /** "New look applied on Oct 12, 2026." with the Revert beside it. */
      newLookApplied: string;
      /** The brand kit's twin of `newLookApplied`. */
      kitApplied: string;
      revertLook: string;
      revertingLook: string;
      lookReverted: string;
      revertFailed: string;
      /** The two studio tabs: the host's own page, and the workspace kit. */
      tabYourPage: string;
      tabBrandKit: string;
      /** Snapshot the workspace kit into this page. */
      applyKit: string;
      applyingKit: string;
      applyKitHint: string;
      kitAppliedToast: string;
      applyKitFailed: string;
      /** Shown instead of Apply kit while the studio has unsaved edits. */
      applyKitSaveFirst: string;
      axisTemplate: string;
      axisCardStyle: string;
      axisCorners: string;
      axisButtons: string;
      axisDensity: string;
      axisFont: string;
      axisSlotLayout: string;
      axisDayGroup: string;
      axisSlotSelect: string;
      /** The booking page's tenth axis (ADR 0004, B2): the GROUND the other
       *  nine are drawn on. Its two values are translated — unlike every other
       *  axis, they are ordinary words rather than design vocabulary. */
      axisTheme: string;
      themeLight: string;
      themeDark: string;
      show: string;
      hide: string;
      noEvents: string;
      orderVisibilityNote: string;
      configureEventTypes: string;
      showLandingPage: string;
      sendVisitorsTo: string;
      chooseEvent: string;
      pickDefaultEvent: string;
      /** What the host's link does, said as a fact under the landing switch. */
      linkOpensEvent: string;
      linkOpensProfile: string;
      /** The opt-out from "one event type opens it directly". */
      alwaysShowProfile: string;
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
      /** Label while a picked photo is being decoded and downscaled. */
      imageWorking: string;
      /** Opened fine, but nothing storable came out (see the teams key). */
      imageCannotShrink: string;
      /** What happens to the picked file — resized, and a GIF loses its motion. */
      imageHelp: string;
      couldNotRead: string;
      introCall: string;
      minSuffix: string;
    };
  };
  // --- O1: onboarding's two gates (ADR 0002) ------------------------------
  // Appended as one namespaced block at the end of the catalogue, per #71's
  // parallel-worktree convention: concurrent units that each append their own
  // block leave git an adjacency to resolve rather than an overlap.
  onboarding: {
    /** Gate 1 — qualification (account level, owner/admin). */
    qualifyTitle: string;
    qualifySubtitle: string;
    /** Labels for Forms' shared question bank, keyed by `question_key`. */
    questions: {
      phone: string;
      industry: string;
      crm: string;
      lead_volume: string;
      lead_source: string;
      use_case: string;
    };
    /** Gate 2 — setup (member level, every active host). */
    templateTitle: string;
    templateSubtitle: string;
    /** Template copy — keys mirror the registry in @slate/engine. */
    template30MinTitle: string;
    template30MinDesc: string;
    template15MinTitle: string;
    template15MinDesc: string;
    template45MinTitle: string;
    template45MinDesc: string;
    template60MinTitle: string;
    template60MinDesc: string;
    /** Intake field labels a template creates on the new event type. */
    intakeTopic: string;
    intakeCompany: string;
    minutes: string;
    continueLabel: string;
    saving: string;
    finish: string;
    finishing: string;
    /** Setup only — the escape hatch that makes the Home checklist reachable. */
    skipForNow: string;
    errorGeneric: string;
  };
  // --- H1a: CRM write-out (#63 / ADR 0001) --------------------------------
  // Appended as its own namespaced block, per #71's parallel-worktree
  // convention. Small on purpose: H1a has no UI, so the only user-facing copy
  // is what a host reads inside the CRM record itself. The connect dialog's
  // copy belongs to H1b.
  crm: {
    /** Body line naming the assigned host (`hubspot_owner_id` is left unset). */
    hostLabel: string;
    /** Body line carrying the booking's uid — traceable, and not a capability. */
    bookingReferenceLabel: string;
    /** Rendering for boolean intake answers. */
    yes: string;
    no: string;
    /** Prefixed onto the meeting title when the booking is cancelled. */
    cancelledTitlePrefix: string;
  };
  /**
   * The inline embed (E). Every string here is read by a HOST inside the admin
   * — the embedded booking page itself carries no copy of its own, because it
   * is the same page under a different padding.
   */
  embed: {
    /** The icon button beside open-public and copy-link on an event-type row. */
    action: string;
    /** Dialog heading. */
    title: string;
    /** One line saying what the snippet is and where it goes. */
    intro: string;
    /** Label over the read-only snippet box. */
    snippetLabel: string;
    copy: string;
    copied: string;
    close: string;
    /** The accent control's label, and its two states. */
    accentLabel: string;
    accentInherit: string;
    accentCustom: string;
    /** Says the frame resizes itself, so nobody hunts for a height setting. */
    resizeNote: string;
    /** Names the URL params a host can hand-add for the other axes. */
    advancedNote: string;
  };
}

export const en: BookingMessages = {
  booking: {
    selectTime: 'Select a time',
    durationMinutes: '{minutes} min',
    timezoneLabel: 'Times shown in {timeZone}',
    timezone: 'Timezone',
    noSlots: 'No available times in this range.',
    noTimesNow: 'No times are available right now. Please check back soon.',
    timesUnavailable: 'We can’t read this calendar right now. Try again in a moment.',
    timesStillUnavailable: 'We still can’t read this calendar. Try again in a minute.',
    calendarUnavailableTitle: 'We couldn’t confirm this time',
    calendarUnavailableBody:
      'We couldn’t check the host’s calendar just now, so nothing was booked. Try again in a moment.',
    book: 'Book',
    confirm: 'Confirm booking',
    confirming: 'Confirming…',
    confirmed: 'Booking confirmed',
    requested: 'Booking requested',
    awaitingConfirmation: 'Awaiting the host’s confirmation. We’ll email {email} once it’s confirmed.',
    confirmationSentTo: 'A confirmation was sent to {email}.',
    yourName: 'Your name',
    yourEmail: 'Your email',
    invalidEmail: 'Enter a valid email.',
    requiredField: 'This field is required.',
    notes: 'Notes (optional)',
    heldUntil: 'Held until {time}',
    slotTaken: 'That time was just taken.',
    holdExpired: 'Your hold expired',
    pickAnother: 'Pick another time',
    retry: 'Try again',
    poweredBy: 'Powered by Dapta Calendars',
    with: 'with',
    seatsLeft: '{n} left',
    full: 'Full',
    // Duplicate-booking guard (#69 / AB1). No date, no time, no host.
    duplicateGuard: {
      title: 'You already have a booking',
      body: 'A booking already exists for this email on this event. Check your inbox for the confirmation.',
      changeEmail: 'Use a different email',
    },
    // One-off links (#110), the invitee's side. No retry: nothing they can do
    // here fixes it, and the copy must not say whether it was used or withdrawn.
    oneOffLink: {
      usedTitle: 'This invite link has already been used',
      usedBody:
        'Invite links work once. Ask the organizer to send you a new one, and it will open a fresh booking page.',
    },
  },
  bookingPage: {
    detailsRegion: 'Event details',
    calendarRegion: 'Choose a date',
    timesRegion: 'Choose a time',
    yourDetails: 'Your details',
    method: 'Scheduling',
    previousMonth: 'Previous month',
    nextMonth: 'Next month',
    today: 'Today',
    pickADay: 'Pick a day to see the times available.',
    readingTimes: 'Finding the times available this month.',
    noTimesOnDay: 'No times available on this day.',
    timesOn: 'Times on {day}',
    timeFormat: 'Time format',
    hour12: '12h',
    hour24: '24h',
    duration: 'Duration',
    backToTimes: 'Back to times',
    descriptionMore: 'Show more',
    descriptionLess: 'Show less',
    backToCalendar: 'Back to the calendar',
    progress: 'Step {step} of {of}',
    what: 'What',
    when: 'When',
    who: 'With',
    addToCalendar: 'Add to calendar',
    minutesUnit: 'min',
    zoneCurrent: 'Showing times in',
    zoneLocal: 'Your time zone',
    zoneAll: 'All time zones',
    hostTimeZone: "{zone}, the host's time",
    nextTimes: 'Next day with times: {day}',
  },
  scheduling: {
    round_robin: 'Round-robin',
    collective: 'Collective',
    fixed_round_robin: 'Fixed round-robin',
    round_robin_hint: 'Rotate bookings fairly across hosts — one host per booking.',
    collective_hint: 'Everyone attends — offer only times when all hosts are free.',
    fixed_round_robin_hint: 'A fixed host always attends, plus one rotating host.',
    distribution: 'Distribution',
    availability: 'Maximize availability',
    availability_hint: 'Offer every time any host is free; the booking goes by priority, then by load.',
    equal: 'Equal distribution',
    equal_hint:
      "Share this event's bookings evenly: a host 3 or more bookings ahead is not offered until the others catch up. Priority and weight don't apply.",
  },
  tzPicker: {
    search: 'Search timezone…',
    noResults: 'No matching timezone.',
  },
  phonePicker: {
    search: 'Search country…',
    noResults: 'No matching country.',
    invalid: 'Enter a valid phone number.',
    countryLabel: 'Country code',
  },
  select: {
    search: 'Search…',
    noResults: 'No matching option.',
  },
  dialog: {
    confirm: 'Confirm',
    cancel: 'Cancel',
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
    cancelThisRequest: 'Cancel this request',
    cancelRequest: 'Cancel request',
    requestCancelled: 'Your request has been cancelled.',
    noOpenTimes: 'No open times in the next 3 weeks.',
    joinMeeting: 'Join the meeting',
    joinMeetingOpensNewTab: ' (opens in a new tab)',
    timeUnreadable: 'We could not read the time for this booking. Check your confirmation email.',
    linkInvalidTitle: 'This link is no longer active',
    linkInvalidBody:
      'Manage links change each time a booking is rescheduled, so an older email carries a link that no longer opens. Your booking has not been affected — open the most recent confirmation or reschedule email to manage it.',
  },
  trouble: {
    busyTitle: 'Busy for a moment',
    busyBody: 'We are getting a lot of requests right now. We will try again in a few seconds.',
    busyRetrying: 'Trying again in {seconds} s.',
    busyStill: 'Still busy. Try again in a minute.',
    tryAgain: 'Try again',
    busyTimes: 'Lots of people are booking right now. The times will show in a moment.',
    holdBusy: 'We could not hold this time just now. You can still book it.',
    holdUnconfirmed: 'We could not check this time with the host’s calendar just now. Try booking it, or pick it again in a moment.',
    holdGone: 'That time was just taken. Pick another.',
    holdFailed: 'We could not hold this time. You can still try to book it.',
    bookBusy: 'Lots of people are booking right now. Your details are still here: press Confirm again in a few seconds.',
    bookFailed: 'That did not go through. Your details are still here: try again in a moment.',
    actionBusy: 'Lots of requests right now. Try again in a few seconds.',
    actionCalendar: 'We could not check the host’s calendar just now, so nothing changed. Try again in a moment.',
    actionTaken: 'That time was just taken. Pick another.',
    actionUnavailable: 'That time is no longer available. Pick another.',
    actionLinkDead: 'This link no longer works. Open the most recent email about this booking.',
    actionFailed: 'That did not go through. Try again in a moment.',
    pickTime: 'Pick a new time first.',
    manageTimesUnavailable: 'We cannot read the host’s calendar right now. Try again in a moment.',
    manageTimesBusy: 'Lots of requests right now. Try again in a few seconds.',
    pageTitle: 'This page didn’t load',
    pageBody: 'Something went wrong on our side. Try again in a moment.',
    manageTitle: 'We couldn’t load your booking',
    manageBody: 'Your booking has not changed. Try again in a moment, or open the link in your most recent email.',
  },
  growth: {
    madeWith: 'Made with Dapta Calendars',
    ctaLine: 'Dapta Calendars is free for anyone.',
    ctaButton: 'Create your free calendar',
    ctaOpensNewTab: '(opens in a new tab)',
    seoProfile: 'Book time with {name} online.',
    seoEvent: '{minutes} min with {name}. Pick a time that works for you.',
    seoEventTitle: '{event} with {name}',
    shareCardCta: 'Book a time',
  },
  landing: {
    timesIn: 'Times in {timeZone}',
    noEvents: 'No bookable events yet.',
    noTeamEvents: 'No bookable team events yet.',
  },
  site: {
    title: '{product}: free online scheduling and booking pages',
    description:
      '{product} gives you a booking page to share with one link. People pick a time in their own time zone, in English or Spanish. Open source.',
    notFoundTitle: 'Page not found',
    notFoundBody: 'This page does not exist. Check the link with the person who shared it.',
    notFoundHome: 'Go home',
    devLandingTitle: 'Open-source scheduling',
    devLandingBody:
      'A booking platform you clone and run. SQLite by default, deploy anywhere. This dev instance is seeded with a demo booking page.',
    devLandingCta: 'Open the demo booking page',
    devLandingTry: 'Try',
  },
  location: {
    whereLabel: 'Where',
    conferencing: 'Online meeting',
    inPerson: 'In person',
    phone: 'Phone call',
    custom: 'Custom',
  },
  admin: {
    nav: {
      home: 'Home',
      bookings: 'Bookings',
      availability: 'Availability',
      eventTypes: 'Events',
      teams: 'Teams',
      calendars: 'Calendars',
      settings: 'Settings',
      bookingPage: 'Booking page',
      connect: 'Connect your agent',
      tools: 'Tools',
      api: 'API and webhooks',
      docs: 'Docs',
      agents: 'Dapta Agents',
    },
    developerNav: {
      keys: 'API keys',
      webhooks: 'Webhooks',
      docs: 'API docs',
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
      accountMenu: 'Account menu',
      language: 'Language',
      notFoundTitle: 'Not found',
      notFoundBody: 'This workspace has nothing at this address. It may have been deleted.',
      collapse: 'Collapse sidebar',
      expand: 'Expand sidebar',
      opensNewTab: 'Opens in a new tab',
      openNav: 'Open navigation',
      primaryNav: 'Primary',
      accountSwitcher: {
        label: 'Switch account',
        trigger: 'Account: {name}',
        search: 'Search accounts',
        noMatch: 'No account matches that.',
        loadMore: 'Load more',
        searching: 'Searching accounts',
        listed: '{count} accounts listed',
        denied: 'You do not have access to that account.',
        failed: 'Could not switch account. Try again.',
      },
      switcher: {
        trigger: 'Switch product',
        menuLabel: 'Dapta products',
        eyebrow: 'Dapta',
        comingSoon: 'Coming soon',
        opensNewTab: '(opens in a new tab)',
        forms: 'Forms',
      },
      theme: {
        toLight: 'Switch to light theme',
        toDark: 'Switch to dark theme',
      },
    },
    home: {
      welcome: 'Welcome',
      welcomeNamed: 'Welcome, {name}',
      subtitle: 'Your scheduling at a glance.',
      bookingLink: 'Your booking link',
      copy: 'Copy',
      copied: 'Copied',
      open: 'Open',
      statEventTypes: 'Events',
      statUpcoming: 'Upcoming bookings',
      statTeams: 'Teams',
      createEvent: 'Create an event',
      createEventDesc: 'Define a bookable meeting.',
      setAvailability: 'Set your availability',
      setAvailabilityDesc: 'Weekly hours + date overrides.',
      stylePage: 'Style your booking page',
      stylePageDesc: 'Brand + 9-axis studio.',
      setupTitle: 'Get bookable',
      setupSubtitle: 'Three steps so a real invite lands in your calendar — not just this dashboard.',
      setupConnectTitle: 'Connect a calendar',
      setupConnectDesc: 'So Dapta Calendars checks real conflicts and writes the event.',
      setupConnectAction: 'Connect',
      setupHoursTitle: 'Set your working hours',
      setupHoursDesc: 'Defines the window your booking link offers.',
      setupHoursAction: 'Create default working hours (Mon–Fri 9–5)',
      setupEventTitle: 'Publish an event type',
      setupEventDesc: 'Until one is live your booking page loads but has nothing to book.',
      setupEventAction: 'Create an event',
      setupDone: 'Done',
      agentBanner: {
        title: 'Control your calendar, bookings and requests from your AI agent',
        body: 'Connect Claude, ChatGPT, Claude Code, Codex, Cursor, OpenClaw or Hermes with your account. No API key.',
        cta: 'Connect your agent',
      },
      agentCard: {
        eyebrow: 'Made for agents',
        title: 'Connect your agent',
        body: 'Ask in your own words. Your agent finds the open times, books the meeting, moves it when plans change and answers every request.',
        cta: 'Connect your agent',
        label: 'An AI agent booking a meeting in {product} from a prompt',
        prompts: [
          'Connect to the {product} MCP and book a 30-minute intro call with Sarah Collins on Thursday.',
          'When is the whole Pulse sales team free for a demo next week? Book the first slot.',
          'Move my 3:00 call tomorrow to Friday morning and let the invitee know.',
          'Accept the booking requests waiting for me, except the one on Saturday.',
          'Cancel my 4:00 call on Friday and tell the invitee I am traveling.',
          'Decline the request for Saturday morning and offer a time next week instead.',
        ],
        done: 'Done. Your calendar is up to date.',
        placeholder: 'Ask {app}…',
        connected: '{product} connected',
        pause: 'Pause the demo',
        play: 'Play the demo',
      },
    },
    settings: {
      title: 'Settings',
      subtitle: 'Manage your account and preferences.',
      general: 'General',
      bookingPage: 'Booking Page',
      members: 'Members',
      notifications: 'Notifications',
      integrations: 'Integrations',
    },
    eventTypes: {
      title: 'Events',
      newEventType: 'New event',
      emptyList: 'No events yet — create one below.',
      hidden: 'hidden',
      needsConfirmation: 'needs confirmation',
      minSuffix: 'min',
      fTitle: 'Title',
      fSlug: 'Slug',
      fDescription: 'Description',
      fLocation: 'Location',
      locationPlaceholder: 'e.g. an address, a phone number, or your own wording',
      locationNone: 'Not specified',
      locationDetailAddress: 'Address',
      locationDetailPhone: 'Phone number',
      locationDetailCustom: 'What to tell invitees',
      locationConferencingHint: 'A meeting link is created automatically when the booking is confirmed.',
      locationNoDestinationWarning:
        'No calendar is connected yet, so no meeting link can be created. Connect one in Connections — bookings still work in the meantime.',
      locationTeamConferencingHint:
        'This location applies to every host. Each booking’s meeting link comes from the calendar where the assigned host receives new events.',
      locationTeamSharedConferencingHint:
        'This location applies to every host. Each booking’s meeting link comes from the calendar where one of its hosts receives new events.',
      locationTeamNoDestinationOne:
        'Bookings assigned to {names} won’t get a meeting link. They need to set their own calendar to receive new events, in Calendars.',
      locationTeamNoDestinationMany:
        'Bookings assigned to {names} won’t get a meeting link. Each of them needs to set their own calendar to receive new events, in Calendars.',
      locationTeamNoDestinationAll:
        'No host has a calendar set to receive new events, so bookings won’t get a meeting link. One of them can set theirs, in Calendars.',
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
      // Duplicate-booking guard (#69 / AB1) — the host-facing switch.
      duplicateGuard: {
        label: 'One booking per person',
        hint: 'Counts upcoming bookings only — cancelling frees the slot, and past bookings never count. You and your API keys are never affected. Anyone who guesses an invitee’s address is told a booking exists for it, though never when it is.',
      },
      // One-off links (#110). Not a security control; say what it does.
      oneOffLinks: {
        title: 'One-off invite links',
        hint: 'Each link books this event once, then stops working. Send one to a single person. Cancelling that booking does not bring the link back — mint another.',
        mint: 'Create invite link',
        minted: 'Invite link created.',
        copiedOnMint: 'Invite link created and copied.',
        copy: 'Copy',
        copied: 'Link copied.',
        revoke: 'Revoke',
        revoked: 'Invite link revoked.',
        empty: 'No invite links yet.',
        saveFirst: 'Save this event before creating invite links.',
        publicWarning:
          'This event is visible on your booking page, so an invite link limits nothing — anyone with the normal link can still book it. Mark the event Hidden to make invite links the only way in.',
        stateLive: 'Ready to send',
        stateConsumed: 'Used',
        stateRevoked: 'Revoked',
        createdAt: 'Created {date}',
        failed: 'Could not do that. Try again.',
      },
      intakeQuestions: 'Intake questions',
      moveUp: 'Move up',
      moveDown: 'Move down',
      reservedBlocked: 'Rename the highlighted question — "name", "email" and "notes" are always asked automatically.',
      defaultCountryLabel: 'Default country',
      openPublic: 'Open booking page',
      copyLink: 'Copy link',
      linkCopied: 'Link copied.',
      toggleVisible: 'Visible on the booking page',
      eventShown: 'Event is now visible.',
      eventHidden: 'Event hidden from the booking page.',
      teamEventsSection: 'Team events',
      fixedFieldsHint: 'The booking page always asks these — no need to add them below.',
      fixedName: 'Your name',
      fixedEmail: 'Your email',
      fixedNotes: 'Notes',
      alwaysAsked: 'built-in',
      reservedWarning: 'Already asked automatically — attendees would answer this twice.',
      namePlaceholder: 'name',
      labelPlaceholder: 'Label',
      req: 'req',
      addQuestion: '+ Add question',
      saved: 'Saved successfully.',
      saveChanges: 'Save changes',
      createEventType: 'Create event',
      saving: 'Saving…',
      schedulingMethod: 'Scheduling method',
      hostsTitle: 'Hosts',
      priority: 'Priority',
      priorityHint:
        'Each booking goes to the free host with the highest priority; weight shares bookings among hosts at the same level.',
      priorityLevels: {
        lowest: 'Lowest',
        low: 'Low',
        medium: 'Medium',
        high: 'High',
        highest: 'Highest',
        custom: 'Custom ({n})',
      },
      weight: 'Weight',
      fixedHost: 'Fixed',
      fixedHostHint: 'Always on every booking',
      calendarLinkManage: 'Manage in Calendars',
      calendarLinkBoth: 'Conflicts checked against & new events added to: {calendar}',
      calendarLinkWriteOnly: 'New events added to: {calendar}. Checked against {n} calendar(s) for conflicts.',
      calendarLinkConflictsOnly: 'Checked against {n} calendar(s) for conflicts. No calendar is set to receive new events.',
      calendarLinkNoDestination: 'No calendar is set to receive new events yet.',
      calendarLinkNone: 'No calendar connected — bookings won’t check your real availability.',
      calendarLinkConnect: 'Connect a calendar',
      calendarsSectionTitle: 'Calendars for this event',
      calendarsSectionHint: 'Choose which connected calendars this event checks for conflicts, and where booked events are added.',
      calendarsCheckConflicts: 'Check for conflicts',
      calendarsAddEventsHere: 'Add events here',
      calendarsManageLink: 'Manage calendars',
      teamHosts: {
        personalHint:
          'A personal event has one host. To share bookings with your team (round-robin or collective), create a team event.',
        newEventFor: 'New event for {team}',
        createTeam: 'Create a team',
        everyMember: 'Every member of {team} hosts this event once you save it.',
        manageOnTeamPage: 'Add or remove members on the team page, then save this event.',
        noHours:
          'No bookings yet, there are no working hours for: {names}. Hours are set at first sign-in and can be changed in Availability.',
        noHoursCollective:
          'No times are offered yet. Everyone attends a collective event, and there are no working hours yet for: {names}. Hours are set at first sign-in and can be changed in Availability.',
        noCalendar:
          'No calendar connected for: {names}. Busy times elsewhere aren’t checked, and nothing is written to a calendar of their own until one is connected in Calendars.',
      },
      reminders: {
        sectionTitle: 'Reminders',
        sectionHint: 'Reminders belong to this event. Each one has its own switch, timing and wording.',
        beforeMeeting: 'Before the meeting',
        afterMeeting: 'After the meeting',
        addReminder: 'Add reminder',
        capReached: 'Up to {max} reminders on one event.',
        sendLabel: 'Send',
        unitMinutes: 'minutes',
        unitHours: 'hours',
        unitDays: 'days',
        beforeStart: 'before it starts',
        afterEnd: 'after it ends',
        subjectLabel: 'Subject',
        bodyLabel: 'Message',
        defaultCopyHint: 'Leave empty to use the standard wording.',
        remove: 'Remove',
        followUpHint: 'A thank-you sent once the meeting is over. Off unless you turn it on.',
        variablesLabel: 'Variables',
        formVariablesLabel: 'From this event’s questions',
        noFormVariables: 'Add a question above to use its answer here.',
        danglingWarn: 'These variables no longer match a question and will arrive empty: {tokens}',
        enabledLabel: 'Send this reminder',
        noReminders: 'No reminders — invitees get no nudge before this event.',
      },
      crmMapping: {
        sectionTitle: 'Send answers to your CRM',
        sectionHint:
          'Pick which answers land on which {provider} contact properties. Each mapped property is overwritten on every accepted booking, so it always shows this contact’s most recent answer.',
        identityTitle: 'Always sent',
        identityHint:
          'Name and email identify the contact, so they cannot be mapped. A contact your CRM already knows keeps the name it has.',
        identityEmail: 'Email',
        identityFirstName: 'First name',
        identityLastName: 'Last name',
        notConnectedTitle: 'No CRM is connected yet',
        notConnectedBody: 'Connect one in Settings to start mapping answers onto contact properties.',
        notConnectedLink: 'Go to Integrations',
        unavailable:
          'We could not reach your CRM to read its properties. Showing the last list we loaded — press Refresh to try again.',
        noProperties:
          'This portal has no contact properties we can write to. Create one in your CRM, then press Refresh.',
        sourceLabel: 'Answer',
        propertyLabel: 'Contact property',
        sourcePlaceholder: 'Choose an answer',
        propertyPlaceholder: 'Choose a property',
        addMapping: '+ Map an answer',
        removeMapping: 'Remove this mapping',
        addTarget: '+ Add another property',
        noMappings: 'No answers are sent to your CRM yet.',
        capReached: 'You can map up to {max} answers on one event.',
        groupQuestions: 'Intake questions',
        groupAttendee: 'Attendee details',
        groupEvent: 'Event details',
        attendeePhone: 'Phone',
        attendeeNotes: 'Notes',
        attendeeTimeZone: 'Time zone',
        attendeeLanguage: 'Language',
        eventTypeTitle: 'Event name',
        eventStart: 'Booking start',
        eventLength: 'Length in minutes',
        eventHostName: 'Assigned host',
        eventHostEmail: 'Assigned host email',
        optionsMatch: 'All options match this property.',
        optionsPartial: '{matched} of {total} options match. These will not be sent: {values}',
        optionsNone:
          'None of this question’s options match this property, so nothing will be sent. Rename them to match, or pick another property.',
        missingProperty: 'This property is no longer in your portal.',
        incompatibleProperty:
          'This property no longer fits this answer’s type, so the save will be refused. Pick another one.',
        missingQuestion:
          'The question this maps from no longer exists. This row is dropped when you save.',
        refresh: 'Refresh properties',
        refreshing: 'Refreshing…',
        suggest: 'Suggest mappings',
        suggestNone: 'Nothing to suggest — no answer matched a property in your portal.',
        suggestFilled: 'Filled in {n}. Review them, then save.',
        suggestNotSaved: 'Suggestions are not saved until you press Save.',
        createInProviderHint:
          'We never create properties. If the one you want is missing, create it in your CRM and press Refresh.',
      },
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
      deleteTitle: 'Delete this schedule?',
      deleteBody: '“{name}” will be removed. Event types using it fall back to your default availability.',
      removeOverride: 'Remove date override',
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
      eventType: 'Event',
      fromSlots: 'From available slots',
      anyTime: 'Any time (outside availability)',
      noSlotsRange: 'No slots in range.',
      loadingSlots: 'Loading available times…',
      dateTimeHost: 'Date & time (host timezone)',
      attendeeName: 'Attendee name',
      attendeeEmail: 'Attendee email',
      attendeeTimezone: 'Attendee timezone',
      pickTime: 'Pick a time.',
      pickerDate: 'Date',
      pickerTime: 'Time',
      pickerMissing: 'not picked yet',
      pickDateTime: 'Pick a date and a time.',
      timesShownIn: 'Times shown in {tz}',
      questionsTitle: 'Questions',
      creating: 'Creating…',
      createBooking: 'Create booking',
      createdTitle: 'Booking created',
      createdNote: 'The attendee has been notified.',
      backToBookings: 'Back to bookings',
      notFoundTitle: 'Booking not found',
      notFoundBody: 'There is no booking at this link in this workspace.',
      newSubtitle: 'Book on behalf of an attendee — from an open slot or any time.',
      createEventFirst: 'Create an event first.',
      noHandleNotice: 'You haven’t set your public handle yet — your booking page isn’t published. Manual bookings below still work.',
      noHandleLink: 'Set your handle',
      slotTaken: 'That time was just taken — pick another slot.',
      scheduleMissingNotice: 'This event’s schedule is missing — pick a schedule in the event settings.',
      scheduleMissingLink: 'Open event settings',
      noHoursNotice: 'No working hours configured for this event’s schedule.',
      noScheduleNotice: 'You don’t have a schedule yet — create one with your working hours.',
      eventQuestions: 'Event questions',
      availabilityLink: 'Open Availability',
      createWorkingHours: 'Create default working hours (Mon–Fri 9–5)',
      creatingWorkingHours: 'Creating…',
      calendarUnavailableNotice:
        'Couldn’t reach the connected calendar — times are hidden to prevent double-bookings.',
      calendarUnavailableLink: 'Check Calendars',
      calendarUnavailableBooking:
        'Couldn’t reach the connected calendar — the booking was blocked to prevent a double-booking. Check Calendars and retry.',
      slotsLoadError: 'Couldn’t load times. Try again in a moment.',
    },
    teams: {
      title: 'Teams',
      subtitle: 'Team scheduling across a group of hosts — round-robin, collective, or fixed round-robin.',
      emptyList: 'No teams yet — create one below to schedule bookings across hosts.',
      newTeam: 'New team',
      name: 'Name',
      slug: 'Slug',
      timezone: 'Timezone',
      createTeam: 'Create team',
      manage: 'Manage',
      delete: 'Delete',
      cancel: 'Cancel',
      deleteError: 'Could not delete.',
      deleteTitle: 'Delete this team?',
      deleteBody: '“{name}” will be deleted permanently. This cannot be undone.',
      removeTitle: 'Remove this member?',
      removeBody: '{name} will lose access to this team. You can add them again later.',
      memberSingular: 'member',
      memberPlural: 'members',
      noMembers: 'No members yet. Add someone from your account below.',
      addMember: 'Add member',
      chooseSomeone: 'Choose someone…',
      role: 'Role',
      // Team-LEVEL role. Named "Team admin" (not "Owner") so it can't be
      // confused with the ACCOUNT owner role — they are separate systems
      // (account: owner/admin/member; team: admin/member). QA fix 5.
      roleOwner: 'Team admin',
      roleMember: 'Member',
      add: 'Add',
      allOnTeam: 'All account members are on this team.',
      remove: 'Remove',
      lastOwner: 'Last team admin',
      lastOwnerTitle: 'A team must keep at least one team admin',
      roleUpdated: 'Role updated.',
      memberRemoved: 'Member removed.',
      memberAdded: 'Member added.',
      genericError: 'Something went wrong.',
      backToTeams: 'Teams',
      viewPublicTeam: 'View public team page',
      roundRobin: 'round-robin scheduling',
      members: 'Members',
      teamEventTypes: 'Team events',
      noTeamEventTypes: 'No team events yet.',
      newTeamEvent: 'New team event',
      inviteTitle: 'Add a member',
      inviteLead: 'Invite someone from your account to this team by email.',
      emailLabel: 'Email',
      emailPlaceholder: 'name@company.com',
      emailInvalid: 'Enter a valid email address.',
      sendInvite: 'Add member',
      ownerLock: 'Team admins can’t be removed — change their role first.',
      memberPending: 'Pending',
      noAccountMember: 'No account member with that email — they need to sign up first.',
      inviteFromMembers: 'Invite them from Members settings',
      createTitle: 'New team',
      createSubtitle: 'Round-robin bookings across a group of hosts. You can add members after creating.',
      bioLabel: 'Bio',
      bioPlaceholder: 'A short description shown on the team’s public page.',
      logoLabel: 'Logo',
      uploadImage: 'Upload image',
      orPasteUrl: '…or paste an image URL',
      clearImage: 'Clear',
      imageTooLarge: 'That image is too large to open. Please choose one under 25MB.',
      imageInvalidType: 'Please choose an image file.',
      imageWorking: 'Resizing…',
      imageCannotShrink: 'That image can’t be made small enough to store. Please try a different one.',
      creating: 'Creating…',
      backToTeamsList: 'Teams',
      imageReadError: 'Could not read that file.',
      nameHelp: 'Shown at the top of the team’s public booking page.',
      slugHelp: 'Used in the public URL. Lowercase letters, numbers and dashes.',
      bioHelp: 'A short line under the team name on the public page.',
      logoHelp: 'Square image works best. Large photos are resized for you; an animated GIF keeps only its first frame.',
    },
    members: {
      title: 'Members',
      subtitle: 'Invite your team and control who can administer this workspace.',
      rosterLabel: 'Workspace members',
      rolesHintOwner: 'Owner — everything an admin can, plus transferring or deleting the workspace. One per workspace: the legal/billing owner.',
      rolesHintAdmin: 'Admin — manages members (except owners), everyone’s events, schedules, bookings and workspace settings.',
      rolesHintMember: 'Member — manages only their own events, schedules and bookings.',
      invite: 'Invite member',
      inviteTitle: 'Invite a member',
      inviteLead: 'They get an invitation to join with the role you choose.',
      emailLabel: 'Email',
      emailPlaceholder: 'name@company.com',
      emailInvalid: 'Enter a valid email address.',
      emailTaken: 'A member with that email already exists.',
      roleLabel: 'Role',
      roleOwner: 'Owner',
      roleAdmin: 'Admin',
      roleMember: 'Member',
      sendInvite: 'Send invite',
      cancel: 'Cancel',
      you: 'You',
      noEmail: 'No email',
      statusActive: 'Active',
      statusInvited: 'Invited',
      statusDisabled: 'Disabled',
      enable: 'Enable',
      disable: 'Disable',
      remove: 'Remove',
      ownerLock: 'Team admins can’t be removed — change their role first.',
      lastOwnerTitle: 'A workspace must keep at least one owner',
      transferOwnership: 'Transfer ownership',
      transferConfirm: 'Yes, transfer — I become an admin',
      removeTitle: 'Remove this member?',
      removeBody: '{name} loses access to this workspace. Their past bookings stay.',
      transferTitle: 'Transfer ownership?',
      transferBody: '{name} becomes the owner and you become an admin. Only they can hand it back.',
      ownershipTransferred: 'Ownership transferred.',
      roleUpdated: 'Role updated.',
      statusUpdated: 'Member updated.',
      memberInvited: 'Invitation sent.',
      memberAddedNoEmail: 'Member added. This server sends no email, so let them know to sign in with that address.',
      inviteEmailFailed: 'Member added, but the invitation email could not be sent. Use Resend invite.',
      inviteLimit: 'This workspace reached today’s invitation limit. Try again tomorrow.',
      resendInvite: 'Resend invite',
      inviteResent: 'Invitation sent again.',
      resendNoEmail: 'This server sends no email, so let them know to sign in with that address.',
      resendTooSoon: 'An invitation just went out. Try again in a minute.',
      memberRemoved: 'Member removed.',
      genericError: 'Something went wrong.',
      noAccessTitle: 'You don’t have access',
      noAccessBody: 'This section is available to workspace admins and owners.',
    },
    workspaces: {
      menuLabel: 'Your workspaces',
      current: 'Current',
      pending: 'Invited',
      switchFailed: 'Could not open that workspace. Try again.',
    },
    invite: {
      pageTitle: 'Invitation',
      joinTitle: 'Join {workspace}',
      joinBody: 'You’re invited as {role}. You keep your own account, and you can switch between them from the menu.',
      join: 'Join workspace',
      joining: 'Joining…',
      joinFailed: 'Could not join this workspace. Try again.',
      notNow: 'Not now',
      openTitle: 'Open {workspace}',
      openBody: 'You’re already a member of this workspace.',
      open: 'Open workspace',
      notForYouTitle: 'This invitation isn’t for this account',
      notForYouBody: 'You’re signed in as {email}. Sign in with the address the invitation was sent to, or ask whoever invited you to send it to this one.',
      otherEmail: 'Sign in with another email',
      goHome: 'Go to my calendar',
    },
    connections: {
      pageDesc: 'Connect a calendar so {product} can check conflicts (busy times) and write your booked events to it.',
      dialogTitle: 'Connect a calendar',
      dialogSubtitle: 'Choose a provider to link.',
      close: 'Close',
      providerGoogle: 'Google Calendar',
      providerOutlook: 'Outlook / Microsoft 365',
      syncOnTitle: 'Calendar sync is on.',
      syncOnDesc: 'Connect Google or Outlook to check conflicts and write events.',
      connectButton: 'Connect a calendar',
      syncOffTitle: 'Calendar sync is off in this build',
      syncOffDesc: 'No external calendar provider is configured, so busy times aren’t being read and events aren’t being written yet. Connections you add below are recorded but not synced.',
      syncOffSetPre: 'To turn sync on, set',
      syncOffSetPost: 'and configure a provider adapter in your deployment.',
      emailStepTitle: 'Which account are you connecting?',
      emailStepLabel: 'Account email',
      emailStepHelp: 'This keeps the new connection separate from any others, and matches it up with the same account if it’s already connected elsewhere in Dapta.',
      emailStepContinue: 'Continue',
      emailStepBack: 'Back',
      connectWaiting: 'Waiting for you to finish connecting…',
      connectHint: 'Finish signing in and granting access in the popup window, then return here.',
      connectDone: 'I’ve finished connecting',
      connectSuccess: 'Calendar connected.',
      connectCancelled: 'Connect cancelled — no calendar was linked.',
      connectFailed: 'Could not start the connect flow. Please try again.',
      connectChecking: 'Checking…',
      connectNotSeenYet:
        'No {provider} connection for {email} yet. Finish the popup window, then check again.',
      connectGaveUp:
        'Still no {provider} connection for {email}. If you signed in with a different account, start again and enter that address.',
      connectCheckFailed: 'Could not check for the connection. Try again in a moment.',
      popupBlocked: 'Your browser blocked the popup. Allow popups for this site and try again.',
      destination: 'Destination',
      conflictCheck: 'Conflict check',
      disconnect: 'Disconnect',
      disconnectError: 'Could not disconnect.',
      disconnectTitle: 'Disconnect this calendar?',
      disconnectBody: '{account} stops being checked for conflicts, and new bookings will not be written to it.',
      accountUnknown: 'Account unknown',
      healthSyncing: 'Syncing',
      healthRecorded: 'Recorded only',
      yourCalendars: 'Your calendars',
      connectAnother: 'Connect another',
      addEventsHere: 'Add new events here',
      addEventsHereHelp: 'Booked events are written to this calendar. Only one calendar can receive events.',
      checkForConflicts: 'Check for conflicts',
      checkForConflictsHelp: 'Busy times on this calendar block new bookings. You can check any number of calendars.',
      summaryDestination: 'New events are added to',
      summaryNoDestination: 'No calendar is set to receive new events yet.',
      summaryConflictsNone: 'No calendars checked for conflicts',
      summaryConflictsOne: '1 calendar checked for conflicts',
      summaryConflictsMany: '{n} calendars checked for conflicts',
      healthChecking: 'Checking…',
      healthOk: 'Connected',
      healthError: 'Needs attention',
      recheck: 'Re-check',
      lastChecked: 'Checked {time}',
      neverChecked: 'Not checked yet',
      emptyTitle: 'No calendars connected yet',
      emptyBody: 'Connect Google or Outlook so {product} can read your busy times and add booked events to your calendar. You can connect more than one account.',
      emptyConflicts: 'Check for conflicts so busy times block new bookings',
      emptyDestination: 'Pick one calendar to receive your booked events',
      alreadyConnectedWithEmail: 'Already connected as {email}. You can connect another account below.',
      alreadyConnectedNoEmail: 'Already connected. You can connect another account below.',
      connectedPageTitle: 'Connected',
      connectedPageBody: 'Your calendar is linked. You can close this window.',
      connectedPageClose: 'Close window',
      connectedPageErrorTitle: 'Could not connect',
      connectedPageErrorBody: 'Close this window and try again from the calendars page.',
      testButton: 'Test',
      testRunning: 'Testing…',
      testOkConflictsOn: 'Working — read {n} events from your calendar in the next 14 days; conflict-checking is ON for this calendar.',
      testOkConflictsOff: 'Working — read {n} events from your calendar in the next 14 days, but conflict-checking is OFF for this calendar. Turn on "Check for conflicts" above.',
      testFailDisconnected: 'Not connected — this calendar isn’t linked yet.',
      testFailNotReady: 'Could not reach your calendar — reauthorization may be required.',
      testFailReadFailed: 'Connected, but reading your events failed.',
      testReconnect: 'Reconnect',
    },
    login: {
      title: 'Sign in',
      subtitle: 'Open-source scheduling. This build uses the local dev provider — enter your email to sign in as yourself.',
      continue: 'Continue',
      footnote: 'Local mode: any email signs you into its own workspace. Configure WorkOS in your deployment for real accounts.',
      emailLabel: 'Email',
      emailPlaceholder: 'you@example.com',
      emailInvalid: 'Enter a valid email address.',
      workosCta: 'Continue with Dapta',
      workosSubtitle: 'You’ll be redirected to sign in securely.',
      error: 'Something went wrong signing in. Please try again.',
      retry: 'Try again',
    },
    session: {
      unavailableTitle: 'We couldn’t renew your session',
      unavailableBody:
        'You’re still signed in. The sign-in service didn’t answer just now, so nothing was changed. Wait a moment and try again.',
      retry: 'Try again',
      signOut: 'Sign out instead',
    },
    settingsGeneral: {
      displayName: 'Display name',
      publicHandle: 'Public handle',
      timezone: 'Timezone',
      saved: 'Saved.',
      save: 'Save',
      saving: 'Saving…',
    },
    brandingSetting: {
      title: 'Dapta branding',
      hint: 'The "Made with Dapta Calendars" badge and the free-calendar invitation on your public pages.',
      switchLabel: 'Show Dapta branding on my pages',
      included: 'Included with your Dapta AI subscription',
      lapsed: 'Your Dapta AI subscription ended, the branding is showing again',
      membersReadOnly: 'Only owners and admins can change this.',
      chipShowing: 'Showing',
      chipHidden: 'Hidden',
      chipShowingAgain: 'Showing again',
      saved: 'Saved.',
      saveFailed: 'Could not save. Try again.',
    },
    notifications: {
      title: 'Notifications',
      subtitle: 'Choose which booking emails go out and edit their templates.',
      attendeeSection: 'Attendee emails',
      attendeeSectionDesc: 'Sent to the person who booked.',
      hostSection: 'Host emails',
      hostSectionDesc: 'Sent to you and any co-hosts.',
      labels: {
        attendee_confirmation: 'Booking confirmed',
        attendee_pending: 'Request received',
        attendee_declined: 'Request declined',
        attendee_reschedule: 'Booking rescheduled',
        attendee_cancellation: 'Booking cancelled',
        attendee_reminder: 'Reminders',
        host_booked: 'New booking',
        host_rescheduled: 'Booking rescheduled',
        host_cancelled: 'Booking cancelled',
        host_declined: 'Request declined',
        follow_up: 'Follow-up after the meeting',
        host_reminder: 'Reminders',
      },
      descriptions: {
        attendee_confirmation: 'Confirmation with calendar invite when a booking is accepted.',
        attendee_pending: 'Acknowledgement when a booking still needs your approval.',
        attendee_declined: 'Notice when you decline a pending request.',
        attendee_reschedule: 'Updated invite when the time changes.',
        attendee_cancellation: 'Cancellation notice with the calendar removal.',
        attendee_reminder: 'Nudges before the meeting starts.',
        host_booked: 'A new booking or booking request came in.',
        host_rescheduled: 'A booking of yours moved to a new time.',
        host_cancelled: 'A booking of yours was cancelled.',
        host_declined: 'Confirmation that a pending request was declined.',
        follow_up: 'Thank-you note with a book-again link, sent after the meeting ends. Off by default.',
        host_reminder: 'Your own nudge before the meeting starts.',
      },
      customizedBadge: 'Customized',
      editTemplate: 'Edit template',
      updated: 'Updated.',
      updateFailed: 'Could not update — try again.',
      editorSubject: 'Subject',
      editorBody: 'Body',
      variables: 'Variables',
      variablesHint: 'Click to insert. Lines whose variables are all empty are left out of the email.',
      unknownTokensWarn: 'Unknown variables render empty:',
      preview: 'Preview',
      usingDefault: 'Using the default template',
      usingCustom: 'Using a custom template',
      reset: 'Reset to default',
      resetDone: 'Template reset to default.',
      resetTitle: 'Reset this template?',
      resetBody: 'Your subject and body are discarded and the shipped copy comes back. This cannot be undone.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved.',
      saveFailed: 'Save failed.',
      back: 'Back to notifications',
    },
    developer: {
      pageLead:
        'Keys for connecting your own systems to your scheduling. If you only book through this dashboard, or connect an AI app with your account, you don’t need anything here.',
      apiKeysLead:
        'Let another system (an AI agent, a CRM, your own app) check availability and create bookings through the API without using this dashboard. Each key is a password for that system — scopes limit what it can do.',
      webhooksLead:
        'Notify an external URL the moment something happens here (a booking is created, rescheduled, or cancelled) so other systems can react automatically — e.g. update a CRM or send a Slack message.',
      apiKeys: 'API keys',
      noKeys: 'No API keys.',
      revoke: 'Revoke',
      revokeTitle: 'Revoke this key?',
      revokeBody: '“{name}” stops working immediately. Anything using it will start failing.',
      deleteWebhookTitle: 'Delete this webhook?',
      deleteWebhookBody: 'No more events will be sent to {url}. Its signing secret is gone for good.',
      deliveryOk: 'Delivered',
      deliveryFailed: 'Failed',
      revoked: 'revoked',
      copyOnce: 'Copy this now — it won’t be shown again:',
      name: 'Name',
      scopes: 'Scopes',
      createKey: 'Create key',
      webhooks: 'Webhooks',
      noWebhooks: 'No webhooks.',
      webhookSecretCopyOnce:
        'Copy this signing secret now — it won’t be shown again. Your subscriber uses it to verify the X-Slate-Signature header on every delivery:',
      webhookNoKeyError:
        'This installation has no encryption key, so a signing secret could only be kept in the clear. We refuse to do that. Ask whoever runs it to set INTEGRATION_ENCRYPTION_KEY, then come back. Webhooks you already have keep working.',
      subscriberUrl: 'Subscriber URL',
      events: 'Events',
      webhookEventLabels: {
        created: 'Booking created',
        rescheduled: 'Booking rescheduled',
        cancelled: 'Booking cancelled',
      },
      addWebhook: 'Add webhook',
      ping: 'Ping',
      deliveries: 'Deliveries',
      noDeliveries: 'No deliveries yet — they appear when a real booking event fires this webhook.',
      creating: 'Creating…',
      loading: 'Loading…',
      delete: 'Delete',
      active: 'active',
      cancel: 'Cancel',
      genericError: 'Something went wrong.',
      revokedToast: 'Key revoked.',
      deletedToast: 'Webhook deleted.',
      toggledToast: 'Webhook updated.',
      copy: 'Copy',
      copied: 'Copied',
      kindRead: 'Read',
      kindWrite: 'Write',
      kindDestructive: 'Destructive',
      toolNeedsNoKey: 'No key needed on a public booking page',
      toolNeedsAnyKey: 'Works with any key',
      toolOrPublic: '(or no key on a public booking page)',
      toolDescriptions: {
        find_available_slots: 'Find free times for an event type.',
        find_team_slots: 'Find free times with a team, and how it assigns hosts.',
        hold_slot: 'Keep a time for about 10 minutes while the person decides.',
        book_meeting: 'Book a time on a public booking page and email the invitee.',
        book_team_meeting: 'Book with a team; a free host is picked for you.',
        whoami: 'Show which account and access the key has.',
        list_my_accounts: 'List the accounts this connection can act in.',
        list_event_types: 'List your event types.',
        get_booking_page_link: 'Get the public booking link for an event type.',
        list_bookings: 'List bookings with the minimum fields.',
        list_pending_bookings: 'List booking requests waiting for your answer.',
        get_booking: 'Read one booking, including what the invitee wrote.',
        create_booking: 'Book a meeting on your behalf. Safe to retry.',
        reschedule_booking: 'Move a booking to another time. The original is replaced and the invitee is told. Safe to retry.',
        confirm_booking: 'Accept a booking request and tell the invitee.',
        decline_booking: 'Turn down a booking request and tell the invitee.',
        cancel_booking: 'Cancel a booking and tell the invitee.',
      },
      scopeLabels: {
        'event-types:read': 'See event types',
        'availability:read': 'Check free times',
        'bookings:read': 'Read bookings',
        'bookings:write': 'Create, hold, reschedule, confirm and decline bookings',
        'bookings:cancel': 'Cancel bookings',
        'calendars:read': 'See connected calendars',
      },
      scopesLead: 'Access this key grants',
      eventTypesLabel: 'Event types',
      eventTypesAll: 'All event types',
      eventTypesOnly: 'Only these event types',
      expiryLabel: 'Expires',
      expiryNever: 'Never',
      expiryDays: 'In {days} days',
      keyScopesUnknown: 'Access not shown',
      keyAllEventTypes: 'All event types',
      keyOnlyEventTypes: 'Only {count} event type(s)',
      keyNoExpiry: 'No expiry',
      keyExpires: 'Expires {date}',
      keyExpired: 'Expired {date}',
      keyLastUsed: 'Last used {date}',
      keyNeverUsed: 'Never used',
      apiRefTitle: 'API reference',
      apiRefLead: 'Every route a key can call, with a try-it console and the machine-readable spec.',
      apiDocs: 'Interactive reference',
      apiOpenApi: 'openapi.json',
      apiRefMissing: 'This installation has no public API address yet. Ask whoever runs it to set API_PUBLIC_URL.',
      connectedTitle: 'Connected apps',
      connectedLead:
        'Apps that signed in to this workspace, such as Claude or Cursor. Each one can do what is listed under it until you disconnect it.',
      connectedNone: 'No connected apps.',
      connectedUnnamed: 'Unnamed app',
      connectedFrom: 'Identified as {host}',
      connectedApprovedBy: 'Approved by {who}',
      connectedSince: 'Connected {date}',
      connectedLastUsed: 'Last used {date}',
      connectedNeverUsed: 'Not used yet',
      connectedRevoke: 'Disconnect',
      connectedRevokeTitle: 'Disconnect this app?',
      connectedRevokeBody:
        '“{name}” can no longer renew its access. Access it already holds keeps working for up to {minutes} min, then stops.',
      connectedRevokedToast: 'App disconnected.',
      connectedExpiryNote:
        'Disconnecting stops an app from renewing its access right away. Access it already holds runs out within {minutes} min.',
      docsPageLead: 'For your own code: every route a key can call, with a try-it console and the machine-readable spec.',
      guideSkillTitle: 'No MCP in your agent?',
      guideSkillBody:
        'Download the skill: a zip that teaches any agent with a terminal to use the {product} API with the same key.',
      guideSkillButton: 'Download the skill',
      guideSkillPending: 'Preparing the skill…',
      guideSkillUnavailable: 'The skill is not available on this installation: it has no public API address yet.',
      guideSkillErrorSession: 'Your session has ended. Sign in again, then download the skill.',
      guideSkillErrorForbidden: 'Only owners and admins can download the skill.',
      guideSkillErrorGeneric: 'The skill could not be downloaded. Try again.',
    },
    connect: {
      eyebrow: 'MCP',
      heading: 'Connect Claude, ChatGPT, Codex or Cursor to {product}',
      intro:
        'Ask your AI assistant to find open times, book, move and cancel meetings and answer booking requests, right from a chat. Log in once with your account and it can work in every workspace where you are an owner or admin.',
      signinTitle: 'Connect with your account',
      recommended: 'Recommended',
      signinIntro: 'Pick your app and follow the steps.',
      benefits: {
        noKey: { title: 'No API key.', body: 'Simply log in to your account. Nothing to create or store.' },
        workspaces: { title: 'One connector, all your workspaces.', body: 'Work in any workspace where you are an owner or admin.' },
        access: {
          title: 'Your access, nothing more.',
          body: 'Owners and admins can connect it, and the agent acts with the access of whoever connected it. Remove an admin role and that connection stops.',
        },
      },
      appsLabel: 'Your AI app',
      urlLabel: 'MCP URL',
      promptLabel: 'Try it',
      prompt: 'What meetings do I have this week in {product}?',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Could not copy. Select the text and copy it by hand.',
      copyUrl: 'Copy URL',
      copyCommand: 'Copy command',
      copyConfig: 'Copy configuration',
      copyPrompt: 'Copy prompt',
      addToCursor: 'Add to Cursor',
      open: {
        claude: 'Open Claude',
        claudeDesktop: 'Open Claude Desktop',
        claudeDirectory: 'Open in the Claude directory',
        newTab: '(opens in a new tab)',
        chatgpt: 'Open ChatGPT',
        copyCommand: 'Copy command',
        copied: 'Copied',
        pasteHint: 'Paste it in your terminal.',
        phoneNote: 'Open this page on your computer to connect {app}.',
      },
      apps: {
        claude: {
          steps: [
            {
              title: 'Open Connectors in Claude',
              body: 'In claude.ai, Claude Desktop or Cowork, click **+** in the chat box, then **Connectors → Add connector → Add custom connector**.',
            },
            {
              title: 'Name it {product} and paste this URL',
              body: 'Use `{product}` as the name and paste the URL below. Leave the advanced settings empty and click **Add**.',
            },
            {
              title: 'Log in to your account',
              body: 'Your browser opens the sign-in page. Enter your email and type the 6-digit code we send you. Back in Claude, {product} shows as **Connected**.',
            },
            {
              title: 'Ask',
              body: 'Open a new chat and ask, for example:',
            },
          ],
        },
        claudeDirectory: {
          steps: [
            {
              title: 'Open {product} in the Claude directory',
              body: 'Click the button below. Or, in Claude, click **+** in the chat box, then **Connectors → Browse connectors**, and search for `{product}`.',
            },
            {
              title: 'Click Connect',
              body: 'On the {product} page of the directory, click **Connect**. Claude opens the {product} sign-in.',
            },
            {
              title: 'Log in to your account',
              body: 'Enter your email and type the 6-digit code we send you. Back in Claude, {product} shows as **Connected**.',
            },
            {
              title: 'Ask',
              body: 'Open a new chat and ask, for example:',
            },
          ],
          fallbackTitle: 'Your organization does not allow the directory?',
          fallbackBody:
            'Add {product} as a custom connector instead: in Claude click **+**, then **Connectors → Add connector → Add custom connector**. Use `{product}` as the name, paste this URL and click **Add**.',
        },
        chatgpt: {
          steps: [
            {
              title: 'Create the app in ChatGPT',
              body: 'In the ChatGPT desktop app, switch to **Work** mode. Open **Plugins**, click **Add** and choose **Create MCP App**.',
            },
            {
              title: 'Fill in the form',
              body: 'Name: `{product}`. Server URL: paste the address below. Leave Authentication on **OAuth**. Check **I understand and want to continue** and create it.',
            },
            {
              title: 'Log in to your account',
              body: 'Click **Continue**. Your browser opens: log in if it asks, then click **Open ChatGPT** to come back.',
            },
            {
              title: 'Install the plugin',
              body: 'In **Plugins**, open the **Personal** tab, choose **{product}** and click **Install plugin**. The browser opens once more to link your account: click **Open ChatGPT** again. That second sign-in is expected.',
            },
            {
              title: 'Ask',
              body: 'Click **Try now**, type `@{product}` and ask, for example:',
            },
          ],
        },
        claudeCode: {
          steps: [
            {
              title: 'Add {product} to Claude Code',
              body: 'In a terminal, run:',
            },
            {
              title: 'Log in to your account',
              body: 'Open Claude Code, run `/mcp`, choose **{server}** and then **Authenticate**. Log in in the browser and come back to the terminal.',
            },
            {
              title: 'Ask',
              body: 'Ask, for example:',
            },
          ],
          note: 'Already connected {product} in Claude? Claude Code logged in with the same Claude account uses that connector too: run `/mcp` to check.',
          directoryTitle: 'Already connected {product} in Claude?',
          directoryBody:
            'Claude Code logged in with the same Claude account brings the {product} connector with it. Run `/mcp` and look for **{product}**. Not there yet? Connect it from the Claude directory, or follow the steps below.',
        },
        codex: {
          steps: [
            {
              title: 'Add {product} to Codex',
              body: 'In a terminal, run:',
            },
            {
              title: 'Log in to your account',
              body: 'Run this command. Your browser opens: log in and come back to the terminal.',
            },
            {
              title: 'Ask',
              body: 'Open Codex and ask, for example:',
            },
          ],
          note: 'Using the Codex or ChatGPT desktop app? Follow the **ChatGPT** tab.',
        },
        cursor: {
          steps: [
            {
              title: 'Add {product} to Cursor',
              body: 'With Cursor installed, click **Add to Cursor**. Or open **Customize → MCPs → New MCP Server**, choose **User** and paste this into `mcp.json`:',
            },
            {
              title: 'Log in to your account',
              body: '**{server}** shows up with **Needs authentication**. Click **Authenticate**, log in in the browser, click **Allow access** and then **Open Cursor**.',
            },
            {
              title: 'Ask',
              body: 'Open a **New Chat** and ask, for example. Cursor asks before it runs a tool: click **Run**.',
            },
          ],
        },
        openclaw: {
          steps: [
            {
              title: 'Add {product} to OpenClaw',
              body: 'In a terminal, save {product} as a remote MCP server that logs in with your account:',
            },
            {
              title: 'Log in to your account',
              body: 'Run this command. Your browser opens: log in and come back to the terminal. `openclaw mcp status --verbose` then shows {server} as authorized.',
            },
            {
              title: 'Ask',
              body: 'Ask your OpenClaw agent, for example:',
            },
          ],
        },
        hermes: {
          steps: [
            {
              title: 'Add {product} to Hermes',
              body: 'Open `~/.hermes/config.yaml` (or run `hermes config edit`) and add {product} under `mcp_servers`:',
            },
            {
              title: 'Log in to your account',
              body: 'Run this command. Your browser opens: log in and come back to the terminal. Then start a new session, or run `/reload-mcp` in the one you have open.',
            },
            {
              title: 'Ask',
              body: 'Ask your Hermes agent, for example:',
            },
          ],
        },
      },
      tip: '**One connector for every workspace.** If you are an owner or admin in several, your AI app asks which one to use. To change, just say “switch to <workspace>”.',
      stepUpNote:
        'On this installation a new connection can only read: the first time you ask your agent to book, move or cancel a meeting, your AI app asks you to approve that too.',
      unavailableTitle: 'The connector is not available on this installation',
      unavailableBody:
        'This installation’s MCP server does not take a sign-in yet, so AI apps cannot connect here. Ask whoever runs it to turn on `MCP_ENABLED` and `OAUTH_ENABLED` and to set `MCP_PUBLIC_URL`.',
      media: {
        terminalLabel: 'Animation: how to connect {product} in {app}',
        play: 'Play the walkthrough',
        pause: 'Pause the walkthrough',
      },
      walkthrough: {
        prompt: 'Find a 30-minute slot on Thursday and book it with Sarah Collins',
        ui: {
          ccWelcome: 'Welcome to Claude Code!',
          ccHelp: '/help for help, /status for your current setup',
          ccAdded: 'Added HTTP MCP server {server} with URL: {url} to user config',
          ccManage: 'Manage MCP servers',
          needsAuth: 'needs authentication',
          authenticate: 'Authenticate',
          ccBrowser: 'Opening your browser to authenticate…',
          ccAuthOk: 'Authentication successful. Connected to {server}.',
          codexAdded: "Added global MCP server '{server}'.",
          codexAuthorize: 'Authorize {server} in your browser to continue.',
          codexLoggedIn: "Successfully logged in to MCP server '{server}'.",
          codexModel: 'model: gpt-5-codex  directory: ~/pulse',
          called: 'Called',
          working: 'Working',
          ocSaved: 'Saved MCP server "{server}" (streamable-http, auth: oauth).',
          ocLogin: 'Opening the browser to sign in to {server}…',
          ocLoggedIn: '{server}: authorized. {count} tools available.',
          hmSaved: 'Saved. Run hermes mcp login {server} to sign in.',
          hmLogin: 'Opening your browser to authorize {server}…',
          hmLoggedIn: '{server}: authorized. Tokens saved.',
        },
        signIn: {
          title: 'Log in to your account',
          emailLabel: 'Email',
          email: 'laura@example.com',
          continue: 'Continue with email',
          checkEmail: 'Check your email',
          codeSentTo: 'Enter the code sent to',
          noCode: 'Didn’t receive a code? You can request a new one in 30 seconds.',
          connected: '{product} is connected to {app}',
          consentTitle: '{app} would like access to your account',
          redirectNote: 'After allowing access, you will be redirected to:',
          warning: 'This redirect points to an application running on your machine. Only allow access if you started this from {app}.',
          allow: 'Allow access',
          cancel: 'Cancel',
        },
        answer: {
          found: 'Thursday has these open times:',
          slots: ['9:30', '10:00', '11:30'],
          booked: 'Booked',
          meeting: 'Intro call with Sarah Collins',
          when: 'Thursday, 10:00 to 10:30',
          calendar: 'On Laura Mendez’s calendar, Pulse',
        },
      },
      toolsTitle: 'What you can do with the MCP',
      toolsIntro: '{count} tools for your open times, bookings and booking requests. Ask in your own words: your AI app picks the tool.',
      toolsLink: 'See every tool',
    },
    tools: {
      title: 'Tools',
      intro:
        'Everything your agent can do in {product} once it is connected: {count} tools. You never call them yourself. Ask in your own words and your agent picks the right one.',
      askLabel: 'Ask:',
      countOne: '1 tool',
      count: '{n} tools',
      connectCta: 'Connect your agent',
      groups: {
        availability: { title: 'Open times', body: 'Find free times on your event types and with a team, the same times your booking page offers.' },
        booking: { title: 'Booking', body: 'Book meetings on your event types, on public booking pages and with a team. The invitee gets the confirmation email.' },
        holds: { title: 'Holds', body: 'Keep a time for a few minutes while the person decides, so nobody else takes it.' },
        bookings: { title: 'Your bookings', body: 'See your meetings, read their details, move them to another time or cancel them.' },
        requests: { title: 'Booking requests', body: 'See the requests waiting for your answer, then accept or decline them.' },
        account: { title: 'Account and event types', body: 'Who is connected, the workspaces you can work in, your event types and their links.' },
      },
      items: {
        find_available_slots: { what: 'See the open times of one event type, day by day.', ask: 'When am I free for a 30-minute call this week?' },
        find_team_slots: { what: 'See when a team event has a free host, or when everyone on the team is free.', ask: 'When is the sales team free for a demo next week?' },
        book_meeting: { what: 'Book a time on a public booking page and email the invitee.', ask: 'Book Thursday at 10:00 on my intro call page for Sarah Collins' },
        book_team_meeting: { what: 'Book with a team. A free host is picked for you.', ask: 'Book the sales demo with whoever is free on Tuesday at 3:00' },
        create_booking: { what: 'Put a meeting on one of your event types for someone, and email them.', ask: 'Add a 30-minute intro call with Sarah Collins on Thursday at 10:00' },
        hold_slot: { what: 'Keep a time for about 10 minutes while the person decides.', ask: 'Hold Thursday at 10:00 while I check with Sarah' },
        list_bookings: { what: 'See your meetings over a range of dates.', ask: 'What meetings do I have this week?' },
        get_booking: { what: 'Open one meeting and read what the invitee wrote.', ask: 'What did Sarah write when she booked?' },
        reschedule_booking: { what: 'Move a meeting to another time. The invitee is told.', ask: 'Move my call with Sarah to Friday at 11:00' },
        cancel_booking: { what: 'Cancel a meeting and tell the invitee.', ask: 'Cancel my 4:00 call on Friday and tell them I am traveling' },
        list_pending_bookings: { what: 'See the booking requests waiting for your answer.', ask: 'Which booking requests are waiting for me?' },
        confirm_booking: { what: 'Accept a booking request and tell the invitee.', ask: 'Accept the request for Thursday' },
        decline_booking: { what: 'Decline a booking request, free its time and tell the invitee.', ask: 'Decline the request for Saturday and say I am away' },
        whoami: { what: 'See which workspace the agent is connected to and what it may do there.', ask: 'Which workspace are you connected to?' },
        list_my_accounts: { what: 'See every workspace you can work in.', ask: 'Which workspaces can you work in?' },
        list_event_types: { what: 'See your event types, personal and team.', ask: 'Which event types do I have?' },
        get_booking_page_link: { what: 'Get the link where anyone can book one event type.', ask: 'Give me the link to my intro call' },
      },
    },
    oauthConsent: {
      pageTitle: 'Connect an app',
      heading: '{client} wants to use your {product} workspace',
      unnamed: 'An app',
      identifiedAs: 'Identified as {host}',
      returnsTo: 'After you answer you go back to {host}.',
      loopbackWarning:
        'This app runs on your own computer. Only allow it if you started this connection yourself, just now.',
      workspace: 'Workspace',
      signedInAs: 'Signed in as {who}',
      scopesLead: 'It will be able to',
      staysConnected: 'It stays connected for up to {days} days, or until you disconnect it under API and webhooks, in API keys.',
      shortLived: 'Its access lasts about an hour; after that it has to ask again.',
      approve: 'Allow',
      deny: 'Deny',
      working: 'One moment…',
      notAdminTitle: 'Only an owner or admin can connect apps',
      notAdminBody:
        'A connected app acts for the whole workspace, so an owner or admin has to connect it. You can still deny this request.',
      expiredTitle: 'This request has expired',
      expiredBody: 'Go back to the app you were connecting and start again.',
      errorBody: 'Something went wrong. Go back to the app you were connecting and try again.',
    },
    integrations: {
      pageLead:
        'Connect your CRM once for the whole workspace. From then on, every booking anyone here accepts becomes a contact and a meeting on that contact, automatically.',
      loadError: 'We could not load the current connection. Refresh to try again.',
      hubspotName: 'HubSpot',
      hubspotDesc:
        'Accepted bookings become a contact and an associated meeting. Reschedules and cancellations update the same meeting, never a second one.',
      disabledTitle: 'Not enabled on this deployment',
      disabledBody:
        'Whoever runs this installation has not switched a CRM on. Ask them to set CRM_PROVIDER, then come back.',
      noKeyTitle: 'Credentials cannot be stored here yet',
      noKeyBody:
        'This installation has no encryption key, so a token could only be kept in the clear. We refuse to do that. Ask whoever runs it to set INTEGRATION_ENCRYPTION_KEY, then come back.',
      unknownTitle: 'We could not check this connection',
      unknownBody:
        'Something went wrong reading this installation\u2019s settings, so we are not offering to connect until we know it would work. Refresh to try again.',
      statusConnected: 'Connected',
      statusUnhealthy: 'Needs attention',
      statusDisconnected: 'Disconnected',
      statusNotConnected: 'Not connected',
      notConnectedBody: 'Nothing is being sent to HubSpot from this workspace.',
      endingIn: 'Token ending in {last4}',
      lastChecked: 'Last checked {date}',
      neverChecked: 'Not used yet — the next accepted booking is the first check.',
      disconnectedBody:
        'The credential was removed. Existing bookings still point at their meetings, so reconnecting the same portal picks up where this left off.',
      unhealthyLead: 'Bookings have stopped reaching HubSpot.',
      unhealthyScopes: 'HubSpot says these scopes are missing from your private app:',
      unhealthyKeepsCredential:
        'The token is still here. Grant the scopes in HubSpot and the next accepted booking goes through on its own — there is nothing to re-paste.',
      unhealthyUnknown: 'HubSpot rejected the last write and did not say why.',
      connect: 'Connect',
      connecting: 'Connecting…',
      reconnect: 'Reconnect',
      disconnect: 'Disconnect',
      disconnecting: 'Disconnecting…',
      disconnectConfirm: 'Stop sending bookings to HubSpot?',
      disconnectNothingDeleted:
        'Nothing is deleted inside HubSpot. Contacts and meetings already there stay exactly as they are.',
      confirmDisconnect: 'Yes, disconnect',
      cancel: 'Cancel',
      dialogTitle: 'Connect HubSpot',
      dialogLead:
        'In HubSpot, open Settings, then Integrations, then Private Apps, and create an app. Grant it the two scopes below, then paste its access token here.',
      scopesTitle: 'Scopes this app needs',
      scopesLead: 'Tick each one off as you grant it in HubSpot. All of them are required.',
      tokenLabel: 'Access token',
      tokenPlaceholder: 'Paste the private app token',
      tokenHelp:
        'We check the token against HubSpot before storing it, and we never show it again after that.',
      labelLabel: 'Portal name (optional)',
      labelPlaceholder: 'e.g. Acme sales portal',
      labelHelp: 'Only so this connection is recognizable later.',
      errorRejected:
        'HubSpot rejected that token. Check that the private app is active and has both scopes.',
      errorMissingScopes: 'HubSpot says these scopes are missing:',
      errorUnverified:
        'We could not reach HubSpot to check that token. Try again in a moment.',
      errorNoKey:
        'This installation cannot store credentials: no encryption key is configured.',
      errorDisabled: 'No CRM is enabled on this installation.',
      errorGeneric: 'Something went wrong. Try again.',
      nothingStored: 'Nothing was saved.',
      connectedToast: 'HubSpot connected.',
      disconnectedToast: 'HubSpot disconnected.',
    },
    brandKit: {
      title: 'Brand kit',
      statement: 'One look for every page in your workspace.',
      statusSet: 'Saved',
      statusUnset: 'Not set yet',
      logo: 'Logo',
      logoHint: 'Shown at the top of the event panel and over the profile cover, as uploaded: use a version that reads on your canvas.',
      accent: 'Accent',
      accentHint: 'Buttons, the selected day and time, links.',
      canvas: 'Canvas',
      canvasHint: 'The ground the page paints on.',
      font: 'Font',
      corners: 'Corners',
      buttons: 'Buttons',
      cardStyle: 'Card style',
      shapeHint: 'Layout, density and how times are listed stay each page\'s own.',
      keepPageOwn: 'Keep each page\'s own',
      save: 'Save kit',
      saving: 'Saving…',
      saved: 'Brand kit saved.',
      saveFailed: 'Could not save the brand kit.',
      readOnly: 'Only an admin or owner can change the brand kit.',
      preview: 'Preview',
      previewHint: 'A booking page wearing this kit.',
      howItWorks: 'How it reaches a page',
      howItWorksBody: 'A host applies the kit from their booking page studio; it is copied onto their page and can be reverted once. Editing the kit later never changes a page by itself. Team pages wear the kit directly.',
      updatedOn: 'Updated {date}',
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
      saveTooLarge: 'Too large to save. Re-upload your photo or cover and try again.',
      profile: 'Profile',
      brand: 'Brand',
      appearance: 'Appearance',
      meetings: 'Meetings',
      displayName: 'Display name',
      publicHandle: 'Public handle',
      yourLink: 'Your booking link',
      linkCopy: 'Copy',
      linkCopied: 'Copied \u2713',
      linkOpen: 'Open',
      vanityLabel: 'Custom link (vanity)',
      vanityHint: 'Included with your Dapta AI subscription. 3\u201330 lowercase letters, numbers, or hyphens; your short code keeps working.',
      vanityIncluded: 'Custom links are included with your Dapta AI subscription.',
      vanityIncludedLink: 'Learn more',
      bio: 'Bio',
      tryHandle: 'Try {handle}',
      accent: 'Accent',
      contrast: 'Label contrast {ratio}:1',
      lowContrast:
        'Low contrast: {ratio}:1 against your page background. Links and buttons may be hard to read. Your color is used exactly as picked.',
      photoAvatar: 'Photo / avatar',
      photoFromConnectedAccount:
        'Your page shows the photo from your connected calendar. Upload one to use your own.',
      connectedPhotoHidden: 'The photo from your connected calendar is off. Your page shows your initials.',
      removeConnectedPhoto: 'Remove',
      useConnectedPhoto: 'Use it again',
      coverImage: 'Cover image',
      custom: 'Custom',
      customizeAppearance: 'Customize appearance',
      newLook: 'Use the new look',
      newLookHint: 'Ink on paper and the minimal set, the look new pages start with. You see it here first.',
      newLookPreviewing: 'Previewing the new look. Save to put it on your page; you can revert it after.',
      newLookApplied: 'New look applied on {date}.',
      kitApplied: 'Brand kit applied on {date}.',
      revertLook: 'Revert',
      revertingLook: 'Reverting…',
      lookReverted: 'Your previous look is back.',
      revertFailed: 'Could not revert. Try again.',
      tabYourPage: 'Your page',
      tabBrandKit: 'Brand kit',
      applyKit: 'Apply brand kit',
      applyingKit: 'Applying…',
      applyKitHint: "Your workspace's logo, colours, font and shape, copied onto this page. You can revert it once.",
      kitAppliedToast: 'Brand kit applied to your page.',
      applyKitFailed: 'Could not apply the brand kit. Try again.',
      applyKitSaveFirst: 'Save or reset your changes first, then apply the kit.',
      axisTemplate: 'Template',
      axisCardStyle: 'Card style',
      axisCorners: 'Corners',
      axisButtons: 'Buttons',
      axisDensity: 'Density',
      axisFont: 'Font',
      axisSlotLayout: 'Slot layout',
      axisDayGroup: 'Day group',
      axisSlotSelect: 'Slot select',
      axisTheme: 'Theme',
      themeLight: 'Light',
      themeDark: 'Dark',
      show: 'Show',
      hide: 'Hide',
      noEvents: 'No events yet.',
      orderVisibilityNote: 'Order + visibility apply to your public page.',
      configureEventTypes: 'Configure events',
      showLandingPage: 'Show the landing page (list of events)',
      sendVisitorsTo: 'Send visitors directly to',
      chooseEvent: 'Choose an event…',
      pickDefaultEvent: 'Pick a default event, or keep the landing page on.',
      linkOpensEvent: 'Your link opens {event} directly.',
      linkOpensProfile: 'Your link opens your profile.',
      alwaysShowProfile: 'Always show my profile, even with one event type',
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
      available: 'Available',
      taken: 'Taken',
      invalid: 'Invalid (3–40 chars, a–z 0–9 -)',
      uploadImage: 'Upload image',
      clear: 'Clear',
      orPasteUrl: '…or paste an image URL',
      imageInvalid: 'Please choose an image file.',
      imageTooLarge: 'That image is too large to open. Please choose one under 25MB.',
      imageWorking: 'Resizing…',
      imageCannotShrink: 'That image can’t be made small enough to store. Please try a different one.',
      imageHelp: 'Large photos are resized for you; an animated GIF keeps only its first frame.',
      couldNotRead: 'Could not read that file.',
      introCall: 'Intro Call',
      minSuffix: 'min',
    },
  },
  onboarding: {
    qualifyTitle: 'Tell us about your work',
    qualifySubtitle: 'A couple of questions so we can set things up for how you actually book.',
    questions: {
      phone: 'Phone number',
      industry: 'What industry are you in?',
      crm: 'Which CRM does your team use?',
      lead_volume: 'How many new leads do you handle in a month?',
      lead_source: 'Where do most of your leads come from?',
      use_case: 'What will you use scheduling for?',
    },
    templateTitle: 'Create your first event',
    templateSubtitle: 'Pick a starting point. You can rename it, re-time it, or add more later.',
    template30MinTitle: '30-minute meeting',
    template30MinDesc: 'The default for most conversations.',
    template15MinTitle: 'Quick call',
    template15MinDesc: 'Short check-ins and intros.',
    template45MinTitle: 'Demo',
    template45MinDesc: 'Enough room to show something properly.',
    template60MinTitle: 'One-on-one',
    template60MinDesc: 'A full hour for deeper conversations.',
    intakeTopic: 'What would you like to discuss?',
    intakeCompany: 'Company',
    minutes: '{minutes} min',
    continueLabel: 'Continue',
    saving: 'Saving…',
    finish: 'Create event and finish',
    finishing: 'Creating…',
    skipForNow: 'Skip for now',
    errorGeneric: 'Something went wrong. Please try again.',
  },
  crm: {
    hostLabel: 'Host',
    bookingReferenceLabel: 'Booking reference',
    yes: 'Yes',
    no: 'No',
    cancelledTitlePrefix: '[Canceled] ',
  },
  embed: {
    action: 'Embed on your site',
    title: 'Embed on your site',
    intro: 'Paste this where the booking page should appear. It sizes itself to fit, and the booking page still loads even if this script is blocked.',
    snippetLabel: 'Embed code',
    copy: 'Copy code',
    copied: 'Copied',
    close: 'Done',
    accentLabel: 'Accent color',
    accentInherit: 'Use my booking page style',
    accentCustom: 'Pick a color for this embed',
    resizeNote: 'The frame grows and shrinks with the page, so you do not need to set a height.',
    advancedNote: 'To change more of the look, add any of these to the embed address: template, card_style, corners, buttons, density, font, slot_layout, day_group, slot_select. A value we do not recognize is ignored.',
  },
};

export const es: BookingMessages = {
  booking: {
    selectTime: 'Selecciona un horario',
    durationMinutes: '{minutes} min',
    timezoneLabel: 'Horarios en {timeZone}',
    timezone: 'Zona horaria',
    noSlots: 'No hay horarios disponibles en este rango.',
    noTimesNow: 'No hay horarios disponibles por el momento. Vuelve a intentarlo pronto.',
    timesUnavailable: 'No podemos leer este calendario ahora mismo. Inténtalo de nuevo en un momento.',
    timesStillUnavailable: 'Aún no podemos leer este calendario. Inténtalo de nuevo en un minuto.',
    calendarUnavailableTitle: 'No pudimos confirmar este horario',
    calendarUnavailableBody:
      'No pudimos revisar el calendario del anfitrión ahora mismo, así que no se reservó nada. Inténtalo de nuevo en un momento.',
    book: 'Reservar',
    confirm: 'Confirmar reserva',
    confirming: 'Confirmando…',
    confirmed: 'Reserva confirmada',
    requested: 'Reserva solicitada',
    awaitingConfirmation: 'Esperando la confirmación del anfitrión. Te escribiremos a {email} cuando se confirme.',
    confirmationSentTo: 'Enviamos una confirmación a {email}.',
    yourName: 'Tu nombre',
    yourEmail: 'Tu correo',
    invalidEmail: 'Ingresa un correo válido.',
    requiredField: 'Este campo es obligatorio.',
    notes: 'Notas (opcional)',
    heldUntil: 'Reservado hasta las {time}',
    slotTaken: 'Ese horario acaba de ocuparse.',
    holdExpired: 'Tu reserva temporal expiró',
    pickAnother: 'Elige otro horario',
    retry: 'Reintentar',
    poweredBy: 'Con la tecnología de Dapta Calendars',
    with: 'con',
    seatsLeft: '{n} disponibles',
    full: 'Lleno',
    // Duplicate-booking guard (#69 / AB1). Sin fecha, sin hora, sin anfitrión.
    duplicateGuard: {
      title: 'Ya tienes una reserva',
      body: 'Ya existe una reserva con este correo en este evento. Revisa tu bandeja de entrada para ver la confirmación.',
      changeEmail: 'Usar otro correo',
    },
    // Enlaces de un solo uso (#110), el lado del invitado. Sin reintento.
    oneOffLink: {
      usedTitle: 'Este enlace de invitación ya se usó',
      usedBody:
        'Los enlaces de invitación funcionan una sola vez. Pídele a quien te invitó que te envíe uno nuevo y se abrirá una página de reserva nueva.',
    },
  },
  bookingPage: {
    detailsRegion: 'Detalles del evento',
    calendarRegion: 'Elige una fecha',
    timesRegion: 'Elige un horario',
    yourDetails: 'Tus datos',
    method: 'Agendamiento',
    previousMonth: 'Mes anterior',
    nextMonth: 'Mes siguiente',
    today: 'Hoy',
    pickADay: 'Elige un día para ver los horarios disponibles.',
    readingTimes: 'Buscando los horarios disponibles de este mes.',
    noTimesOnDay: 'No hay horarios disponibles este día.',
    timesOn: 'Horarios del {day}',
    timeFormat: 'Formato de hora',
    hour12: '12 h',
    hour24: '24 h',
    duration: 'Duración',
    backToTimes: 'Volver a los horarios',
    descriptionMore: 'Ver más',
    descriptionLess: 'Ver menos',
    backToCalendar: 'Volver al calendario',
    progress: 'Paso {step} de {of}',
    what: 'Qué',
    when: 'Cuándo',
    who: 'Con',
    addToCalendar: 'Añadir al calendario',
    minutesUnit: 'min',
    zoneCurrent: 'Horarios mostrados en',
    zoneLocal: 'Tu zona horaria',
    zoneAll: 'Todas las zonas horarias',
    hostTimeZone: '{zone}, hora del anfitrión',
    nextTimes: 'Siguiente día con horarios: {day}',
  },
  scheduling: {
    round_robin: 'Por turnos',
    collective: 'Colectiva',
    fixed_round_robin: 'Turnos con anfitrión fijo',
    round_robin_hint: 'Reparte las reservas de forma equitativa entre anfitriones — uno por reserva.',
    collective_hint: 'Todos asisten — ofrece solo horarios en que todos los anfitriones están libres.',
    fixed_round_robin_hint: 'Un anfitrión fijo siempre asiste, más uno por turnos.',
    distribution: 'Distribución',
    availability: 'Maximizar disponibilidad',
    availability_hint:
      'Ofrece cada horario en que algún anfitrión esté libre; la reserva se asigna por prioridad y luego por carga.',
    equal: 'Distribución equitativa',
    equal_hint:
      'Reparte por igual las reservas de este evento: un anfitrión con 3 o más reservas de ventaja no se ofrece hasta que los demás lo alcancen. La prioridad y el peso no aplican.',
  },
  tzPicker: {
    search: 'Buscar zona horaria…',
    noResults: 'No hay zonas que coincidan.',
  },
  phonePicker: {
    search: 'Buscar país…',
    noResults: 'No hay países que coincidan.',
    invalid: 'Ingresa un número de teléfono válido.',
    countryLabel: 'Código de país',
  },
  select: {
    search: 'Buscar…',
    noResults: 'No hay opciones que coincidan.',
  },
  dialog: {
    confirm: 'Confirmar',
    cancel: 'Cancelar',
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
    cancelThisRequest: 'Cancelar esta solicitud',
    cancelRequest: 'Cancelar solicitud',
    requestCancelled: 'Tu solicitud fue cancelada.',
    noOpenTimes: 'No hay horarios disponibles en las próximas 3 semanas.',
    joinMeeting: 'Unirse a la reunión',
    joinMeetingOpensNewTab: ' (se abre en una pestaña nueva)',
    timeUnreadable: 'No pudimos leer la hora de esta reserva. Revisa tu correo de confirmación.',
    linkInvalidTitle: 'Este enlace ya no está activo',
    linkInvalidBody:
      'Los enlaces de gestión cambian cada vez que se reprograma una reserva, así que un correo anterior lleva un enlace que ya no abre. Tu reserva no se ha visto afectada: abre el correo de confirmación o de reprogramación más reciente para gestionarla.',
  },
  trouble: {
    busyTitle: 'Un momento, por favor',
    busyBody: 'Estamos recibiendo muchas solicitudes ahora mismo. Lo intentaremos de nuevo en unos segundos.',
    busyRetrying: 'Reintentando en {seconds} s.',
    busyStill: 'Sigue ocupado. Inténtalo de nuevo en un minuto.',
    tryAgain: 'Reintentar',
    busyTimes: 'Hay mucha gente reservando ahora mismo. Los horarios aparecerán en un momento.',
    holdBusy: 'No pudimos apartar este horario ahora mismo. Aún puedes reservarlo.',
    holdUnconfirmed: 'No pudimos revisar este horario en el calendario del anfitrión. Intenta reservarlo, o vuelve a elegirlo en un momento.',
    holdGone: 'Ese horario acaba de ocuparse. Elige otro.',
    holdFailed: 'No pudimos apartar este horario. Aún puedes intentar reservarlo.',
    bookBusy: 'Hay mucha gente reservando ahora mismo. Tus datos siguen aquí: vuelve a confirmar en unos segundos.',
    bookFailed: 'No se pudo completar. Tus datos siguen aquí: inténtalo de nuevo en un momento.',
    actionBusy: 'Hay muchas solicitudes ahora mismo. Inténtalo de nuevo en unos segundos.',
    actionCalendar: 'No pudimos revisar el calendario del anfitrión ahora mismo, así que nada cambió. Inténtalo de nuevo en un momento.',
    actionTaken: 'Ese horario acaba de ocuparse. Elige otro.',
    actionUnavailable: 'Ese horario ya no está disponible. Elige otro.',
    actionLinkDead: 'Este enlace ya no funciona. Abre el correo más reciente sobre esta reserva.',
    actionFailed: 'No se pudo completar. Inténtalo de nuevo en un momento.',
    pickTime: 'Primero elige un horario nuevo.',
    manageTimesUnavailable: 'No podemos leer el calendario del anfitrión ahora mismo. Inténtalo de nuevo en un momento.',
    manageTimesBusy: 'Hay muchas solicitudes ahora mismo. Inténtalo de nuevo en unos segundos.',
    pageTitle: 'Esta página no cargó',
    pageBody: 'Algo falló de nuestro lado. Inténtalo de nuevo en un momento.',
    manageTitle: 'No pudimos cargar tu reserva',
    manageBody: 'Tu reserva no ha cambiado. Inténtalo de nuevo en un momento, o abre el enlace de tu correo más reciente.',
  },
  growth: {
    madeWith: 'Hecho con Dapta Calendars',
    ctaLine: 'Dapta Calendars es gratis para todos.',
    ctaButton: 'Crea tu calendario gratis',
    ctaOpensNewTab: '(se abre en una pestaña nueva)',
    seoProfile: 'Reserva un horario con {name} en línea.',
    seoEvent: '{minutes} min con {name}. Elige la hora que te funcione.',
    seoEventTitle: '{event} con {name}',
    shareCardCta: 'Reserva una hora',
  },
  landing: {
    timesIn: 'Horarios en {timeZone}',
    noEvents: 'Aún no hay eventos disponibles para reservar.',
    noTeamEvents: 'Aún no hay eventos de equipo disponibles para reservar.',
  },
  site: {
    title: '{product}: agenda de citas en línea gratis',
    description:
      '{product} te da una página de reservas para compartir con un solo enlace. Cada persona elige una hora en su propia zona horaria, en español o en inglés. Código abierto.',
    notFoundTitle: 'Página no encontrada',
    notFoundBody: 'Esta página no existe. Revisa el enlace con quien te lo compartió.',
    notFoundHome: 'Ir al inicio',
    devLandingTitle: 'Agenda de código abierto',
    devLandingBody:
      'Una plataforma de reservas que clonas y ejecutas. SQLite por defecto, despliégala donde quieras. Esta instancia de desarrollo trae una página de reservas de demostración.',
    devLandingCta: 'Abrir la página demo',
    devLandingTry: 'Prueba',
  },
  location: {
    whereLabel: 'Dónde',
    conferencing: 'Reunión en línea',
    inPerson: 'Presencial',
    phone: 'Llamada telefónica',
    custom: 'Personalizado',
  },
  admin: {
    nav: {
      home: 'Inicio',
      bookings: 'Reservas',
      availability: 'Disponibilidad',
      eventTypes: 'Eventos',
      teams: 'Equipos',
      calendars: 'Calendarios',
      settings: 'Ajustes',
      bookingPage: 'Página de reservas',
      connect: 'Conecta tu agente',
      tools: 'Herramientas',
      api: 'API y webhooks',
      docs: 'Documentación',
      agents: 'Dapta Agents',
    },
    developerNav: {
      keys: 'Claves API',
      webhooks: 'Webhooks',
      docs: 'Docs de la API',
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
      accountMenu: 'Menú de la cuenta',
      language: 'Idioma',
      notFoundTitle: 'No encontrado',
      notFoundBody: 'Este espacio no tiene nada en esta dirección. Puede que se haya eliminado.',
      collapse: 'Contraer barra lateral',
      expand: 'Expandir barra lateral',
      opensNewTab: 'Se abre en una pestaña nueva',
      openNav: 'Abrir navegación',
      primaryNav: 'Principal',
      accountSwitcher: {
        label: 'Cambiar de cuenta',
        trigger: 'Cuenta: {name}',
        search: 'Buscar cuentas',
        noMatch: 'Ninguna cuenta coincide.',
        loadMore: 'Cargar más',
        searching: 'Buscando cuentas',
        listed: '{count} cuentas en la lista',
        denied: 'No tienes acceso a esa cuenta.',
        failed: 'No se pudo cambiar de cuenta. Inténtalo de nuevo.',
      },
      switcher: {
        trigger: 'Cambiar producto',
        menuLabel: 'Productos Dapta',
        eyebrow: 'Dapta',
        comingSoon: 'Próximamente',
        opensNewTab: '(se abre en una pestaña nueva)',
        forms: 'Forms',
      },
      theme: {
        toLight: 'Cambiar al tema claro',
        toDark: 'Cambiar al tema oscuro',
      },
    },
    home: {
      welcome: 'Bienvenido',
      welcomeNamed: 'Bienvenido, {name}',
      subtitle: 'Tu agenda de un vistazo.',
      bookingLink: 'Tu enlace de reservas',
      copy: 'Copiar',
      copied: 'Copiado',
      open: 'Abrir',
      statEventTypes: 'Eventos',
      statUpcoming: 'Próximas reservas',
      statTeams: 'Equipos',
      createEvent: 'Crear un evento',
      createEventDesc: 'Define una reunión reservable.',
      setAvailability: 'Configura tu disponibilidad',
      setAvailabilityDesc: 'Horas semanales + excepciones por fecha.',
      stylePage: 'Personaliza tu página de reservas',
      stylePageDesc: 'Marca + estudio de 9 ejes.',
      setupTitle: 'Queda lista para reservas',
      setupSubtitle: 'Tres pasos para que una invitación real llegue a tu calendario — no solo a este panel.',
      setupConnectTitle: 'Conecta un calendario',
      setupConnectDesc: 'Así Dapta Calendars revisa conflictos reales y escribe el evento.',
      setupConnectAction: 'Conectar',
      setupHoursTitle: 'Define tus horas de trabajo',
      setupHoursDesc: 'Define la ventana que ofrece tu enlace de reservas.',
      setupHoursAction: 'Crear horario de trabajo por defecto (lun–vie 9–5)',
      setupEventTitle: 'Publica un tipo de evento',
      setupEventDesc: 'Hasta que publiques uno tu página de reservas carga, pero no hay nada que reservar.',
      setupEventAction: 'Crear un evento',
      setupDone: 'Listo',
      agentBanner: {
        title: 'Controla tu calendario, tus reservas y solicitudes desde tu agente de IA',
        body: 'Conecta Claude, ChatGPT, Claude Code, Codex, Cursor, OpenClaw o Hermes con tu cuenta. Sin clave API.',
        cta: 'Conecta tu agente',
      },
      agentCard: {
        eyebrow: 'Hecho para agentes',
        title: 'Conecta tu agente',
        body: 'Pide con tus palabras. Tu agente busca los horarios libres, agenda la reunión, la mueve si cambian los planes y responde cada solicitud.',
        cta: 'Conecta tu agente',
        label: 'Un agente de IA agendando una reunión en {product} a partir de un prompt',
        prompts: [
          'Conéctate al MCP de {product} y agenda una llamada inicial de 30 minutos con Sarah Collins el jueves.',
          '¿Cuándo está libre todo el equipo de ventas de Pulse para una demo la próxima semana? Reserva el primer horario.',
          'Mueve mi llamada de mañana a las 3:00 al viernes en la mañana y avísale al invitado.',
          'Acepta las solicitudes de reserva que me esperan, menos la del sábado.',
          'Cancela mi llamada del viernes a las 4:00 y dile al invitado que estoy de viaje.',
          'Rechaza la solicitud del sábado en la mañana y ofrece un horario la próxima semana.',
        ],
        done: 'Listo. Tu calendario está al día.',
        placeholder: 'Pregúntale a {app}…',
        connected: '{product} conectado',
        pause: 'Pausar la demostración',
        play: 'Reproducir la demostración',
      },
    },
    settings: {
      title: 'Ajustes',
      subtitle: 'Gestiona tu cuenta y preferencias.',
      general: 'General',
      bookingPage: 'Página de reservas',
      members: 'Miembros',
      notifications: 'Notificaciones',
      integrations: 'Integraciones',
    },
    eventTypes: {
      title: 'Eventos',
      newEventType: 'Nuevo evento',
      emptyList: 'Aún no hay eventos — crea uno abajo.',
      hidden: 'oculto',
      needsConfirmation: 'requiere confirmación',
      minSuffix: 'min',
      fTitle: 'Título',
      fSlug: 'Identificador',
      fDescription: 'Descripción',
      fLocation: 'Ubicación',
      locationPlaceholder: 'p. ej. una dirección, un teléfono o tu propio texto',
      locationNone: 'Sin especificar',
      locationDetailAddress: 'Dirección',
      locationDetailPhone: 'Número de teléfono',
      locationDetailCustom: 'Qué indicar a los invitados',
      locationConferencingHint: 'El enlace de la reunión se crea automáticamente al confirmar la reserva.',
      locationNoDestinationWarning:
        'Aún no hay ningún calendario conectado, así que no se puede crear el enlace. Conecta uno en Conexiones — las reservas siguen funcionando mientras tanto.',
      locationTeamConferencingHint:
        'Esta ubicación aplica a todos los anfitriones. El enlace de cada reunión se crea en el calendario donde el anfitrión asignado recibe eventos nuevos.',
      locationTeamSharedConferencingHint:
        'Esta ubicación aplica a todos los anfitriones. El enlace de cada reunión se crea en el calendario donde uno de sus anfitriones recibe eventos nuevos.',
      locationTeamNoDestinationOne:
        'Las reservas asignadas a {names} no tendrán enlace de reunión. Debe elegir su propio calendario para recibir eventos nuevos, en Calendarios.',
      locationTeamNoDestinationMany:
        'Las reservas asignadas a {names} no tendrán enlace de reunión. Cada uno debe elegir su propio calendario para recibir eventos nuevos, en Calendarios.',
      locationTeamNoDestinationAll:
        'Ningún anfitrión tiene un calendario para recibir eventos nuevos, así que las reservas no tendrán enlace de reunión. Basta con que uno elija el suyo, en Calendarios.',
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
      // Duplicate-booking guard (#69 / AB1) — el interruptor del anfitrión.
      duplicateGuard: {
        label: 'Una reserva por persona',
        hint: 'Solo cuenta las reservas próximas — cancelar libera el espacio y las reservas pasadas nunca cuentan. Ni tú ni tus claves de API se ven afectados. A quien adivine el correo de un invitado se le dirá que existe una reserva, aunque nunca cuándo es.',
      },
      // Enlaces de un solo uso (#110). No es un control de seguridad.
      oneOffLinks: {
        title: 'Enlaces de invitación de un solo uso',
        hint: 'Cada enlace reserva este evento una vez y luego deja de funcionar. Envía uno a una sola persona. Cancelar esa reserva no reactiva el enlace — crea otro.',
        mint: 'Crear enlace de invitación',
        minted: 'Enlace de invitación creado.',
        copiedOnMint: 'Enlace de invitación creado y copiado.',
        copy: 'Copiar',
        copied: 'Enlace copiado.',
        revoke: 'Revocar',
        revoked: 'Enlace de invitación revocado.',
        empty: 'Aún no hay enlaces de invitación.',
        saveFirst: 'Guarda este evento antes de crear enlaces de invitación.',
        publicWarning:
          'Este evento es visible en tu página de reservas, así que un enlace de invitación no limita nada — cualquiera con el enlace normal puede reservarlo igual. Marca el evento como Oculto para que los enlaces de invitación sean la única vía.',
        stateLive: 'Listo para enviar',
        stateConsumed: 'Usado',
        stateRevoked: 'Revocado',
        createdAt: 'Creado el {date}',
        failed: 'No se pudo completar. Inténtalo de nuevo.',
      },
      intakeQuestions: 'Preguntas del formulario',
      moveUp: 'Subir',
      moveDown: 'Bajar',
      reservedBlocked: 'Renombra la pregunta marcada — "name", "email" y "notes" siempre se preguntan automáticamente.',
      defaultCountryLabel: 'País por defecto',
      openPublic: 'Abrir página de reservas',
      copyLink: 'Copiar enlace',
      linkCopied: 'Enlace copiado.',
      toggleVisible: 'Visible en la página de reservas',
      eventShown: 'El evento ya es visible.',
      eventHidden: 'Evento oculto de la página de reservas.',
      teamEventsSection: 'Eventos de equipo',
      fixedFieldsHint: 'La página de reservas siempre pregunta esto — no hace falta añadirlas abajo.',
      fixedName: 'Tu nombre',
      fixedEmail: 'Tu correo',
      fixedNotes: 'Notas',
      alwaysAsked: 'fija',
      reservedWarning: 'Ya se pregunta automáticamente — el invitado respondería dos veces.',
      namePlaceholder: 'nombre',
      labelPlaceholder: 'Etiqueta',
      req: 'obl.',
      addQuestion: '+ Añadir pregunta',
      saved: 'Guardado correctamente.',
      saveChanges: 'Guardar cambios',
      createEventType: 'Crear evento',
      saving: 'Guardando…',
      schedulingMethod: 'Método de programación',
      hostsTitle: 'Anfitriones',
      priority: 'Prioridad',
      priorityHint:
        'Cada reserva va al anfitrión libre con la prioridad más alta; el peso reparte las reservas entre anfitriones del mismo nivel.',
      priorityLevels: {
        lowest: 'Muy baja',
        low: 'Baja',
        medium: 'Media',
        high: 'Alta',
        highest: 'Muy alta',
        custom: 'Personalizada ({n})',
      },
      weight: 'Peso',
      fixedHost: 'Fijo',
      fixedHostHint: 'Siempre en cada reserva',
      calendarLinkManage: 'Administrar en Calendarios',
      calendarLinkBoth: 'Conflictos verificados contra y eventos nuevos añadidos a: {calendar}',
      calendarLinkWriteOnly: 'Eventos nuevos añadidos a: {calendar}. Verificado contra {n} calendario(s) para conflictos.',
      calendarLinkConflictsOnly: 'Verificado contra {n} calendario(s) para conflictos. Ningún calendario está configurado para recibir eventos nuevos.',
      calendarLinkNoDestination: 'Aún no hay un calendario configurado para recibir eventos nuevos.',
      calendarLinkNone: 'Ningún calendario conectado — las reservas no verificarán tu disponibilidad real.',
      calendarLinkConnect: 'Conectar un calendario',
      calendarsSectionTitle: 'Calendarios para este evento',
      calendarsSectionHint: 'Elige qué calendarios conectados verifica este evento para conflictos, y dónde se añaden los eventos reservados.',
      calendarsCheckConflicts: 'Verificar conflictos',
      calendarsAddEventsHere: 'Añadir eventos aquí',
      calendarsManageLink: 'Administrar calendarios',
      teamHosts: {
        personalHint:
          'Un evento personal tiene un solo anfitrión. Para compartir reservas con tu equipo (por turnos o colectiva), crea un evento de equipo.',
        newEventFor: 'Nuevo evento para {team}',
        createTeam: 'Crear un equipo',
        everyMember: 'Todos los miembros de {team} quedan como anfitriones de este evento al guardarlo.',
        manageOnTeamPage: 'Agrega o quita miembros en la página del equipo y luego guarda este evento.',
        noHours:
          'Aún sin reservas, no hay horario de trabajo para: {names}. El horario se crea al iniciar sesión por primera vez y se cambia en Disponibilidad.',
        noHoursCollective:
          'Aún no se ofrecen horarios. En un evento colectivo asisten todos, y todavía no hay horario de trabajo para: {names}. El horario se crea al iniciar sesión por primera vez y se cambia en Disponibilidad.',
        noCalendar:
          'Sin calendario conectado para: {names}. No se revisan sus horas ocupadas en otros calendarios y nada se escribe en un calendario propio hasta conectar uno en Calendarios.',
      },
      reminders: {
        sectionTitle: 'Recordatorios',
        sectionHint:
          'Los recordatorios son de este evento. Cada uno tiene su propio interruptor, momento y texto.',
        beforeMeeting: 'Antes de la reunión',
        afterMeeting: 'Después de la reunión',
        addReminder: 'Añadir recordatorio',
        capReached: 'Hasta {max} recordatorios por evento.',
        sendLabel: 'Enviar',
        unitMinutes: 'minutos',
        unitHours: 'horas',
        unitDays: 'días',
        beforeStart: 'antes de que empiece',
        afterEnd: 'después de que termine',
        subjectLabel: 'Asunto',
        bodyLabel: 'Mensaje',
        defaultCopyHint: 'Déjalo vacío para usar el texto estándar.',
        remove: 'Quitar',
        followUpHint:
          'Un agradecimiento que se envía cuando la reunión termina. Desactivado salvo que lo actives.',
        variablesLabel: 'Variables',
        formVariablesLabel: 'De las preguntas de este evento',
        noFormVariables: 'Añade una pregunta arriba para usar su respuesta aquí.',
        danglingWarn: 'Estas variables ya no coinciden con ninguna pregunta y llegarán vacías: {tokens}',
        enabledLabel: 'Enviar este recordatorio',
        noReminders: 'Sin recordatorios: nadie recibirá aviso antes de este evento.',
      },
      crmMapping: {
        sectionTitle: 'Enviar respuestas a tu CRM',
        sectionHint:
          'Elige qué respuestas llegan a qué propiedades de contacto en {provider}. Cada propiedad asignada se sobrescribe en cada reserva aceptada, así que siempre muestra la respuesta más reciente de ese contacto.',
        identityTitle: 'Siempre se envía',
        identityHint:
          'El nombre y el correo identifican al contacto, por eso no se pueden asignar. Un contacto que tu CRM ya conoce conserva el nombre que tiene.',
        identityEmail: 'Correo',
        identityFirstName: 'Nombre',
        identityLastName: 'Apellido',
        notConnectedTitle: 'Todavía no hay ningún CRM conectado',
        notConnectedBody:
          'Conecta uno en Ajustes para empezar a asignar respuestas a propiedades de contacto.',
        notConnectedLink: 'Ir a Integraciones',
        unavailable:
          'No pudimos conectar con tu CRM para leer sus propiedades. Mostramos la última lista que cargamos: pulsa Actualizar para reintentar.',
        noProperties:
          'Este portal no tiene propiedades de contacto en las que podamos escribir. Crea una en tu CRM y pulsa Actualizar.',
        sourceLabel: 'Respuesta',
        propertyLabel: 'Propiedad de contacto',
        sourcePlaceholder: 'Elige una respuesta',
        propertyPlaceholder: 'Elige una propiedad',
        addMapping: '+ Asignar una respuesta',
        removeMapping: 'Quitar esta asignación',
        addTarget: '+ Añadir otra propiedad',
        noMappings: 'Todavía no se envía ninguna respuesta a tu CRM.',
        capReached: 'Puedes asignar hasta {max} respuestas en un evento.',
        groupQuestions: 'Preguntas del formulario',
        groupAttendee: 'Datos del invitado',
        groupEvent: 'Datos del evento',
        attendeePhone: 'Teléfono',
        attendeeNotes: 'Notas',
        attendeeTimeZone: 'Zona horaria',
        attendeeLanguage: 'Idioma',
        eventTypeTitle: 'Nombre del evento',
        eventStart: 'Inicio de la reserva',
        eventLength: 'Duración en minutos',
        eventHostName: 'Anfitrión asignado',
        eventHostEmail: 'Correo del anfitrión asignado',
        optionsMatch: 'Todas las opciones coinciden con esta propiedad.',
        optionsPartial:
          '{matched} de {total} opciones coinciden. Estas no se enviarán: {values}',
        optionsNone:
          'Ninguna opción de esta pregunta coincide con la propiedad, así que no se enviará nada. Renómbralas para que coincidan o elige otra propiedad.',
        missingProperty: 'Esta propiedad ya no está en tu portal.',
        incompatibleProperty:
          'Esta propiedad ya no encaja con el tipo de esta respuesta, así que el guardado se rechazará. Elige otra.',
        missingQuestion:
          'La pregunta de la que proviene ya no existe. Esta fila se descarta al guardar.',
        refresh: 'Actualizar propiedades',
        refreshing: 'Actualizando…',
        suggest: 'Sugerir asignaciones',
        suggestNone: 'Nada que sugerir: ninguna respuesta coincidió con una propiedad de tu portal.',
        suggestFilled: 'Se rellenaron {n}. Revísalas y guarda.',
        suggestNotSaved: 'Las sugerencias no se guardan hasta que pulses Guardar.',
        createInProviderHint:
          'Nunca creamos propiedades. Si falta la que quieres, créala en tu CRM y pulsa Actualizar.',
      },
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
      deleteTitle: '¿Eliminar este horario?',
      deleteBody: 'Se eliminará «{name}». Los eventos que lo usan volverán a tu disponibilidad predeterminada.',
      removeOverride: 'Quitar excepción de fecha',
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
      eventType: 'Evento',
      fromSlots: 'Desde horarios disponibles',
      anyTime: 'Cualquier hora (fuera de disponibilidad)',
      noSlotsRange: 'No hay horarios en el rango.',
      loadingSlots: 'Cargando horarios disponibles…',
      dateTimeHost: 'Fecha y hora (zona del anfitrión)',
      attendeeName: 'Nombre del invitado',
      attendeeEmail: 'Correo del invitado',
      attendeeTimezone: 'Zona horaria del invitado',
      pickTime: 'Elige una hora.',
      pickerDate: 'Fecha',
      pickerTime: 'Hora',
      pickerMissing: 'sin elegir',
      pickDateTime: 'Elige una fecha y una hora.',
      timesShownIn: 'Horas en {tz}',
      questionsTitle: 'Preguntas',
      creating: 'Creando…',
      createBooking: 'Crear reserva',
      createdTitle: 'Reserva creada',
      createdNote: 'Se ha notificado al invitado.',
      backToBookings: 'Volver a reservas',
      notFoundTitle: 'Reserva no encontrada',
      notFoundBody: 'No hay ninguna reserva en este enlace dentro de este espacio.',
      newSubtitle: 'Reserva en nombre de un invitado — desde un horario libre o cualquier hora.',
      createEventFirst: 'Primero crea un evento.',
      noHandleNotice: 'Aún no has definido tu identificador público — tu página de reservas no está publicada. Las reservas manuales de abajo sí funcionan.',
      noHandleLink: 'Definir mi identificador',
      slotTaken: 'Ese horario acaba de ocuparse — elige otro.',
      scheduleMissingNotice:
        'Falta el horario de este evento — elige un horario en la configuración del evento.',
      scheduleMissingLink: 'Abrir configuración del evento',
      noHoursNotice: 'No hay horas de trabajo configuradas para el horario de este evento.',
      noScheduleNotice: 'Aún no tienes un horario — crea uno con tus horas de trabajo.',
      eventQuestions: 'Preguntas del evento',
      availabilityLink: 'Abrir Disponibilidad',
      createWorkingHours: 'Crear horario de trabajo por defecto (lun–vie 9–5)',
      creatingWorkingHours: 'Creando…',
      calendarUnavailableNotice:
        'No se pudo acceder al calendario conectado — los horarios se ocultan para evitar dobles reservas.',
      calendarUnavailableLink: 'Revisar Calendarios',
      calendarUnavailableBooking:
        'No se pudo acceder al calendario conectado — la reserva se bloqueó para evitar una doble reserva. Revisa Calendarios y reintenta.',
      slotsLoadError: 'No se pudieron cargar los horarios. Inténtalo de nuevo en un momento.',
    },
    teams: {
      title: 'Equipos',
      subtitle: 'Programación de equipo entre un grupo de anfitriones — por turnos, colectiva o con anfitrión fijo.',
      emptyList: 'Aún no hay equipos — crea uno abajo para programar reservas entre anfitriones.',
      newTeam: 'Nuevo equipo',
      name: 'Nombre',
      slug: 'Identificador',
      timezone: 'Zona horaria',
      createTeam: 'Crear equipo',
      manage: 'Gestionar',
      delete: 'Eliminar',
      cancel: 'Cancelar',
      deleteError: 'No se pudo eliminar.',
      deleteTitle: '¿Eliminar este equipo?',
      deleteBody: '“{name}” se eliminará de forma permanente. Esta acción no se puede deshacer.',
      removeTitle: '¿Quitar a este miembro?',
      removeBody: '{name} perderá el acceso a este equipo. Puedes volver a añadirle más adelante.',
      memberSingular: 'miembro',
      memberPlural: 'miembros',
      noMembers: 'Aún no hay miembros. Añade a alguien de tu cuenta abajo.',
      addMember: 'Añadir miembro',
      chooseSomeone: 'Elige a alguien…',
      role: 'Rol',
      roleOwner: 'Admin del equipo',
      roleMember: 'Miembro',
      add: 'Añadir',
      allOnTeam: 'Todos los miembros de la cuenta están en este equipo.',
      remove: 'Quitar',
      lastOwner: 'Último admin del equipo',
      lastOwnerTitle: 'Un equipo debe conservar al menos un admin del equipo',
      roleUpdated: 'Rol actualizado.',
      memberRemoved: 'Miembro eliminado.',
      memberAdded: 'Miembro añadido.',
      genericError: 'Algo salió mal.',
      backToTeams: 'Equipos',
      viewPublicTeam: 'Ver página pública del equipo',
      roundRobin: 'programación por turnos',
      members: 'Miembros',
      teamEventTypes: 'Eventos del equipo',
      noTeamEventTypes: 'Aún no hay eventos del equipo.',
      newTeamEvent: 'Nuevo evento de equipo',
      inviteTitle: 'Añadir un miembro',
      inviteLead: 'Invita por correo a alguien de tu cuenta a este equipo.',
      emailLabel: 'Correo',
      emailPlaceholder: 'nombre@empresa.com',
      emailInvalid: 'Introduce un correo válido.',
      sendInvite: 'Añadir miembro',
      ownerLock: 'Los admins del equipo no se pueden quitar — cambia su rol primero.',
      memberPending: 'Pendiente',
      noAccountMember: 'No hay ningún miembro de la cuenta con ese correo — primero debe registrarse.',
      inviteFromMembers: 'Invítalo desde la configuración de Miembros',
      createTitle: 'Nuevo equipo',
      createSubtitle: 'Reparte reservas por turnos entre un grupo de anfitriones. Puedes añadir miembros después de crearlo.',
      bioLabel: 'Biografía',
      bioPlaceholder: 'Una breve descripción que se muestra en la página pública del equipo.',
      logoLabel: 'Logo',
      uploadImage: 'Subir imagen',
      orPasteUrl: '…o pega una URL de imagen',
      clearImage: 'Quitar',
      imageTooLarge: 'Esa imagen es demasiado grande para abrirse. Elige una de menos de 25MB.',
      imageInvalidType: 'Elige un archivo de imagen.',
      imageWorking: 'Redimensionando…',
      imageCannotShrink: 'No se puede reducir esa imagen lo suficiente para guardarla. Prueba con otra.',
      creating: 'Creando…',
      backToTeamsList: 'Equipos',
      imageReadError: 'No se pudo leer el archivo.',
      nameHelp: 'Se muestra en la parte superior de la página pública del equipo.',
      slugHelp: 'Se usa en la URL pública. Minúsculas, números y guiones.',
      bioHelp: 'Una línea breve bajo el nombre del equipo en la página pública.',
      logoHelp: 'Una imagen cuadrada funciona mejor. Las fotos grandes se redimensionan automáticamente; de un GIF animado solo se conserva el primer fotograma.',
    },
    members: {
      title: 'Miembros',
      subtitle: 'Invita a tu equipo y controla quién puede administrar este espacio.',
      rosterLabel: 'Miembros del espacio',
      rolesHintOwner: 'Propietario — todo lo de un admin, más transferir o borrar el espacio. Uno por espacio: el dueño legal/facturable.',
      rolesHintAdmin: 'Administrador — gestiona miembros (excepto propietarios), y los eventos, horarios, reservas y ajustes de todos.',
      rolesHintMember: 'Miembro — gestiona solo sus propios eventos, horarios y reservas.',
      invite: 'Invitar miembro',
      inviteTitle: 'Invitar a un miembro',
      inviteLead: 'Recibirá una invitación para unirse con el rol que elijas.',
      emailLabel: 'Correo',
      emailPlaceholder: 'nombre@empresa.com',
      emailInvalid: 'Introduce un correo válido.',
      emailTaken: 'Ya existe un miembro con ese correo.',
      roleLabel: 'Rol',
      roleOwner: 'Propietario',
      roleAdmin: 'Administrador',
      roleMember: 'Miembro',
      sendInvite: 'Enviar invitación',
      cancel: 'Cancelar',
      you: 'Tú',
      noEmail: 'Sin correo',
      statusActive: 'Activo',
      statusInvited: 'Invitación pendiente',
      statusDisabled: 'Desactivado',
      enable: 'Activar',
      disable: 'Desactivar',
      remove: 'Quitar',
      ownerLock: 'Los admins del equipo no se pueden quitar — cambia su rol primero.',
      lastOwnerTitle: 'Un espacio debe conservar al menos un propietario',
      transferOwnership: 'Transferir propiedad',
      transferConfirm: 'Sí, transferir — yo paso a admin',
      removeTitle: '¿Quitar a esta persona?',
      removeBody: '{name} perderá el acceso a este espacio. Sus reservas anteriores se conservan.',
      transferTitle: '¿Transferir la propiedad?',
      transferBody: '{name} pasará a ser propietario y tú pasarás a administrador. Solo esa persona puede devolvértela.',
      ownershipTransferred: 'Propiedad transferida.',
      roleUpdated: 'Rol actualizado.',
      statusUpdated: 'Miembro actualizado.',
      memberInvited: 'Invitación enviada.',
      memberAddedNoEmail: 'Miembro añadido. Este servidor no envía correos, así que avísale que inicie sesión con ese correo.',
      inviteEmailFailed: 'Miembro añadido, pero no pudimos enviar el correo de invitación. Usa Reenviar invitación.',
      inviteLimit: 'Este espacio llegó al límite de invitaciones de hoy. Intenta de nuevo mañana.',
      resendInvite: 'Reenviar invitación',
      inviteResent: 'Invitación reenviada.',
      resendNoEmail: 'Este servidor no envía correos, así que avísale que inicie sesión con ese correo.',
      resendTooSoon: 'Acabamos de enviar una invitación. Intenta de nuevo en un minuto.',
      memberRemoved: 'Miembro eliminado.',
      genericError: 'Algo salió mal.',
      noAccessTitle: 'No tienes acceso',
      noAccessBody: 'Esta sección está disponible para administradores y propietarios del espacio.',
    },
    workspaces: {
      menuLabel: 'Tus espacios',
      current: 'Actual',
      pending: 'Invitación pendiente',
      switchFailed: 'No pudimos abrir ese espacio. Intenta de nuevo.',
    },
    invite: {
      pageTitle: 'Invitación',
      joinTitle: 'Únete a {workspace}',
      joinBody: 'Te invitaron como {role}. Conservas tu propia cuenta y puedes cambiar entre las dos desde el menú.',
      join: 'Unirme al espacio',
      joining: 'Uniéndote…',
      joinFailed: 'No pudimos unirte a este espacio. Intenta de nuevo.',
      notNow: 'Ahora no',
      openTitle: 'Abrir {workspace}',
      openBody: 'Ya eres miembro de este espacio.',
      open: 'Abrir espacio',
      notForYouTitle: 'Esta invitación no es para esta cuenta',
      notForYouBody: 'Iniciaste sesión como {email}. Inicia sesión con el correo al que llegó la invitación, o pide a quien te invitó que la envíe a este.',
      otherEmail: 'Iniciar sesión con otro correo',
      goHome: 'Ir a mi calendario',
    },
    connections: {
      pageDesc: 'Conecta un calendario para que {product} pueda verificar conflictos (horas ocupadas) y escribir en él tus reservas.',
      dialogTitle: 'Conectar un calendario',
      dialogSubtitle: 'Elige un proveedor para vincular.',
      close: 'Cerrar',
      providerGoogle: 'Google Calendar',
      providerOutlook: 'Outlook / Microsoft 365',
      syncOnTitle: 'La sincronización de calendario está activa.',
      syncOnDesc: 'Conecta Google u Outlook para verificar conflictos y escribir eventos.',
      connectButton: 'Conectar un calendario',
      syncOffTitle: 'La sincronización de calendario está desactivada en esta versión',
      syncOffDesc: 'No hay ningún proveedor de calendario externo configurado, así que aún no se leen horas ocupadas ni se escriben eventos. Las conexiones que añadas abajo se registran pero no se sincronizan.',
      syncOffSetPre: 'Para activar la sincronización, define',
      syncOffSetPost: 'y configura un adaptador de proveedor en tu despliegue.',
      emailStepTitle: '¿Qué cuenta vas a conectar?',
      emailStepLabel: 'Correo de la cuenta',
      emailStepHelp: 'Esto mantiene la nueva conexión separada de las demás y la vincula con la misma cuenta si ya está conectada en otra parte de Dapta.',
      emailStepContinue: 'Continuar',
      emailStepBack: 'Atrás',
      connectWaiting: 'Esperando a que termines de conectar…',
      connectHint: 'Termina de iniciar sesión y de dar acceso en la ventana emergente y luego vuelve aquí.',
      connectDone: 'Ya terminé de conectar',
      connectSuccess: 'Calendario conectado.',
      connectCancelled: 'Conexión cancelada: no se vinculó ningún calendario.',
      connectFailed: 'No se pudo iniciar la conexión. Inténtalo de nuevo.',
      connectChecking: 'Comprobando…',
      connectNotSeenYet:
        'Todavía no hay una conexión de {provider} para {email}. Termina en la ventana emergente y vuelve a comprobar.',
      connectGaveUp:
        'Sigue sin haber una conexión de {provider} para {email}. Si iniciaste sesión con otra cuenta, empieza de nuevo y escribe esa dirección.',
      connectCheckFailed: 'No se pudo comprobar la conexión. Inténtalo de nuevo en un momento.',
      popupBlocked: 'Tu navegador bloqueó la ventana emergente. Permite ventanas emergentes e inténtalo de nuevo.',
      destination: 'Destino',
      conflictCheck: 'Verificar conflictos',
      disconnect: 'Desconectar',
      disconnectError: 'No se pudo desconectar.',
      disconnectTitle: '¿Desconectar este calendario?',
      disconnectBody: 'Dejaremos de comprobar conflictos en {account} y las nuevas reservas no se escribirán ahí.',
      accountUnknown: 'Cuenta desconocida',
      healthSyncing: 'Sincronizando',
      healthRecorded: 'Solo registrado',
      yourCalendars: 'Tus calendarios',
      connectAnother: 'Conectar otro',
      addEventsHere: 'Añadir eventos nuevos aquí',
      addEventsHereHelp: 'Las reservas se escriben en este calendario. Solo un calendario puede recibir eventos.',
      checkForConflicts: 'Verificar conflictos',
      checkForConflictsHelp: 'Las horas ocupadas en este calendario bloquean nuevas reservas. Puedes verificar cualquier número de calendarios.',
      summaryDestination: 'Los eventos nuevos se añaden a',
      summaryNoDestination: 'Aún no hay un calendario configurado para recibir eventos nuevos.',
      summaryConflictsNone: 'Ningún calendario verificado por conflictos',
      summaryConflictsOne: '1 calendario verificado por conflictos',
      summaryConflictsMany: '{n} calendarios verificados por conflictos',
      healthChecking: 'Comprobando…',
      healthOk: 'Conectado',
      healthError: 'Requiere atención',
      recheck: 'Volver a comprobar',
      lastChecked: 'Comprobado {time}',
      neverChecked: 'Sin comprobar todavía',
      emptyTitle: 'Aún no hay calendarios conectados',
      emptyBody: 'Conecta Google u Outlook para que {product} pueda leer tus horas ocupadas y añadir las reservas a tu calendario. Puedes conectar más de una cuenta.',
      emptyConflicts: 'Verifica conflictos para que las horas ocupadas bloqueen nuevas reservas',
      emptyDestination: 'Elige un calendario para recibir tus reservas',
      alreadyConnectedWithEmail: 'Ya conectado como {email}. Puedes conectar otra cuenta abajo.',
      alreadyConnectedNoEmail: 'Ya conectado. Puedes conectar otra cuenta abajo.',
      connectedPageTitle: 'Conectado',
      connectedPageBody: 'Tu calendario está vinculado. Puedes cerrar esta ventana.',
      connectedPageClose: 'Cerrar ventana',
      connectedPageErrorTitle: 'No se pudo conectar',
      connectedPageErrorBody: 'Cierra esta ventana e inténtalo de nuevo desde la página de calendarios.',
      testButton: 'Probar',
      testRunning: 'Probando…',
      testOkConflictsOn: 'Funciona — se leyeron {n} eventos de tu calendario en los próximos 14 días; la verificación de conflictos está ACTIVADA para este calendario.',
      testOkConflictsOff: 'Funciona — se leyeron {n} eventos de tu calendario en los próximos 14 días, pero la verificación de conflictos está DESACTIVADA para este calendario. Activa "Verificar conflictos" arriba.',
      testFailDisconnected: 'No conectado — este calendario aún no está vinculado.',
      testFailNotReady: 'No se pudo contactar tu calendario — puede requerir reautorización.',
      testFailReadFailed: 'Conectado, pero no se pudieron leer tus eventos.',
      testReconnect: 'Reconectar',
    },
    login: {
      title: 'Iniciar sesión',
      subtitle: 'Programación de código abierto. Esta versión usa el proveedor de desarrollo local — introduce tu correo para entrar como tú mismo.',
      continue: 'Continuar',
      footnote: 'Modo local: cualquier correo entra a su propio espacio. Configura WorkOS en tu despliegue para cuentas reales.',
      emailLabel: 'Correo',
      emailPlaceholder: 'tu@ejemplo.com',
      emailInvalid: 'Introduce un correo válido.',
      workosCta: 'Continuar con Dapta',
      workosSubtitle: 'Te redirigiremos para iniciar sesión de forma segura.',
      error: 'Algo salió mal al iniciar sesión. Inténtalo de nuevo.',
      retry: 'Reintentar',
    },
    session: {
      unavailableTitle: 'No pudimos renovar tu sesión',
      unavailableBody:
        'Tu sesión sigue activa. El servicio de inicio de sesión no respondió ahora mismo, así que no se cambió nada. Espera un momento e inténtalo de nuevo.',
      retry: 'Reintentar',
      signOut: 'Cerrar sesión',
    },
    settingsGeneral: {
      displayName: 'Nombre visible',
      publicHandle: 'Identificador público',
      timezone: 'Zona horaria',
      saved: 'Guardado.',
      save: 'Guardar',
      saving: 'Guardando…',
    },
    brandingSetting: {
      title: 'Marca de Dapta',
      hint: 'La insignia "Hecho con Dapta Calendars" y la invitación a crear un calendario gratis en tus páginas públicas.',
      switchLabel: 'Mostrar la marca de Dapta en mis páginas',
      included: 'Incluido con tu suscripción de Dapta AI',
      lapsed: 'Tu suscripción de Dapta AI terminó, la marca se muestra de nuevo',
      membersReadOnly: 'Solo los propietarios y administradores pueden cambiar esto.',
      chipShowing: 'Visible',
      chipHidden: 'Oculta',
      chipShowingAgain: 'Visible de nuevo',
      saved: 'Guardado.',
      saveFailed: 'No se pudo guardar. Inténtalo de nuevo.',
    },
    notifications: {
      title: 'Notificaciones',
      subtitle: 'Elige qué correos de reservas se envían y edita sus plantillas.',
      attendeeSection: 'Correos al asistente',
      attendeeSectionDesc: 'Enviados a la persona que reservó.',
      hostSection: 'Correos al anfitrión',
      hostSectionDesc: 'Enviados a ti y a los co-anfitriones.',
      labels: {
        attendee_confirmation: 'Reserva confirmada',
        attendee_pending: 'Solicitud recibida',
        attendee_declined: 'Solicitud rechazada',
        attendee_reschedule: 'Reserva reprogramada',
        attendee_cancellation: 'Reserva cancelada',
        attendee_reminder: 'Recordatorios',
        host_booked: 'Nueva reserva',
        host_rescheduled: 'Reserva reprogramada',
        host_cancelled: 'Reserva cancelada',
        host_declined: 'Solicitud rechazada',
        follow_up: 'Seguimiento tras la reunión',
        host_reminder: 'Recordatorios',
      },
      descriptions: {
        attendee_confirmation: 'Confirmación con invitación de calendario al aceptar la reserva.',
        attendee_pending: 'Acuse de recibo cuando la reserva requiere tu aprobación.',
        attendee_declined: 'Aviso cuando rechazas una solicitud pendiente.',
        attendee_reschedule: 'Invitación actualizada cuando cambia la hora.',
        attendee_cancellation: 'Aviso de cancelación con la eliminación del calendario.',
        attendee_reminder: 'Avisos antes de que empiece la reunión.',
        host_booked: 'Entró una nueva reserva o solicitud de reserva.',
        host_rescheduled: 'Una de tus reservas cambió de hora.',
        host_cancelled: 'Una de tus reservas fue cancelada.',
        host_declined: 'Confirmación de que una solicitud pendiente fue rechazada.',
        follow_up: 'Nota de agradecimiento con enlace para reservar de nuevo, enviada al terminar la reunión. Desactivada por defecto.',
        host_reminder: 'Tu propio aviso antes de que empiece la reunión.',
      },
      customizedBadge: 'Personalizada',
      editTemplate: 'Editar plantilla',
      updated: 'Actualizado.',
      updateFailed: 'No se pudo actualizar — inténtalo de nuevo.',
      editorSubject: 'Asunto',
      editorBody: 'Cuerpo',
      variables: 'Variables',
      variablesHint: 'Haz clic para insertar. Las líneas cuyas variables queden vacías se omiten del correo.',
      unknownTokensWarn: 'Variables desconocidas se muestran vacías:',
      preview: 'Vista previa',
      usingDefault: 'Usando la plantilla predeterminada',
      usingCustom: 'Usando una plantilla personalizada',
      reset: 'Restablecer predeterminada',
      resetDone: 'Plantilla restablecida.',
      resetTitle: '¿Restablecer esta plantilla?',
      resetBody: 'Se descartarán tu asunto y tu cuerpo y volverá el texto original. Esto no se puede deshacer.',
      save: 'Guardar',
      saving: 'Guardando…',
      saved: 'Guardado.',
      saveFailed: 'Error al guardar.',
      back: 'Volver a notificaciones',
    },
    developer: {
      pageLead:
        'Claves para conectar tus propios sistemas con tu agenda. Si solo reservas desde este panel, o conectas una app de IA con tu cuenta, no necesitas nada de esta página.',
      apiKeysLead:
        'Permiten que otro sistema (un agente de IA, un CRM, tu propia app) consulte disponibilidad y cree reservas por API sin usar este panel. Cada clave es una contraseña para ese sistema — los permisos limitan qué puede hacer.',
      webhooksLead:
        'Avisan a una URL externa en el momento en que algo pasa aquí (se crea, reagenda o cancela una reserva) para que otros sistemas reaccionen automáticamente — p. ej. actualizar un CRM o mandar un mensaje a Slack.',
      apiKeys: 'Claves API',
      noKeys: 'No hay claves API.',
      revoke: 'Revocar',
      revokeTitle: '¿Revocar esta clave?',
      revokeBody: '«{name}» dejará de funcionar de inmediato. Lo que la use empezará a fallar.',
      deleteWebhookTitle: '¿Eliminar este webhook?',
      deleteWebhookBody: 'No se enviarán más eventos a {url}. Su secreto de firma se pierde definitivamente.',
      deliveryOk: 'Entregado',
      deliveryFailed: 'Falló',
      revoked: 'revocada',
      copyOnce: 'Cópiala ahora — no se volverá a mostrar:',
      name: 'Nombre',
      scopes: 'Permisos',
      createKey: 'Crear clave',
      webhooks: 'Webhooks',
      noWebhooks: 'No hay webhooks.',
      webhookSecretCopyOnce:
        'Copia ahora esta clave de firma — no se volverá a mostrar. Tu suscriptor la usa para verificar la cabecera X-Slate-Signature en cada entrega:',
      webhookNoKeyError:
        'Esta instalación no tiene clave de cifrado, así que una clave de firma solo podría guardarse sin proteger. Nos negamos a hacerlo. Pide a quien la administra que configure INTEGRATION_ENCRYPTION_KEY y vuelve. Los webhooks que ya tienes siguen funcionando.',
      subscriberUrl: 'URL del suscriptor',
      events: 'Eventos',
      webhookEventLabels: {
        created: 'Reserva creada',
        rescheduled: 'Reserva reagendada',
        cancelled: 'Reserva cancelada',
      },
      addWebhook: 'Añadir webhook',
      ping: 'Probar',
      deliveries: 'Entregas',
      noDeliveries: 'Aún no hay entregas — aparecerán cuando un evento real de reserva dispare este webhook.',
      creating: 'Creando…',
      loading: 'Cargando…',
      delete: 'Eliminar',
      active: 'activo',
      cancel: 'Cancelar',
      genericError: 'Algo salió mal.',
      revokedToast: 'Clave revocada.',
      deletedToast: 'Webhook eliminado.',
      toggledToast: 'Webhook actualizado.',
      copy: 'Copiar',
      copied: 'Copiado',
      kindRead: 'Lectura',
      kindWrite: 'Escritura',
      kindDestructive: 'Destructiva',
      toolNeedsNoKey: 'Sin clave en una página de reservas pública',
      toolNeedsAnyKey: 'Funciona con cualquier clave',
      toolOrPublic: '(o sin clave en una página de reservas pública)',
      toolDescriptions: {
        find_available_slots: 'Busca horarios libres de un tipo de evento.',
        find_team_slots: 'Busca horarios libres con un equipo y cómo asigna anfitriones.',
        hold_slot: 'Aparta un horario unos 10 minutos mientras la persona decide.',
        book_meeting: 'Reserva un horario en una página pública y avisa al invitado por correo.',
        book_team_meeting: 'Reserva con un equipo; se asigna un anfitrión libre.',
        whoami: 'Muestra a qué cuenta y acceso corresponde la clave.',
        list_my_accounts: 'Lista las cuentas en las que puede actuar esta conexión.',
        list_event_types: 'Lista tus tipos de evento.',
        get_booking_page_link: 'Obtiene el enlace público de reservas de un tipo de evento.',
        list_bookings: 'Lista reservas con los campos mínimos.',
        list_pending_bookings: 'Lista las solicitudes de reserva que esperan tu respuesta.',
        get_booking: 'Lee una reserva, incluido lo que escribió el invitado.',
        create_booking: 'Reserva una reunión en tu nombre. Se puede reintentar sin riesgo.',
        reschedule_booking: 'Mueve una reserva a otro horario. La original se reemplaza y se avisa al invitado. Se puede reintentar sin riesgo.',
        confirm_booking: 'Acepta una solicitud de reserva y avisa al invitado.',
        decline_booking: 'Rechaza una solicitud de reserva y avisa al invitado.',
        cancel_booking: 'Cancela una reserva y avisa al invitado.',
      },
      scopeLabels: {
        'event-types:read': 'Ver tipos de evento',
        'availability:read': 'Consultar horarios libres',
        'bookings:read': 'Leer reservas',
        'bookings:write': 'Crear, apartar, reagendar, confirmar y rechazar reservas',
        'bookings:cancel': 'Cancelar reservas',
        'calendars:read': 'Ver calendarios conectados',
      },
      scopesLead: 'Acceso que da esta clave',
      eventTypesLabel: 'Tipos de evento',
      eventTypesAll: 'Todos los tipos de evento',
      eventTypesOnly: 'Solo estos tipos de evento',
      expiryLabel: 'Vence',
      expiryNever: 'Nunca',
      expiryDays: 'En {days} días',
      keyScopesUnknown: 'Acceso no disponible',
      keyAllEventTypes: 'Todos los tipos de evento',
      keyOnlyEventTypes: 'Solo {count} tipo(s) de evento',
      keyNoExpiry: 'Sin vencimiento',
      keyExpires: 'Vence el {date}',
      keyExpired: 'Venció el {date}',
      keyLastUsed: 'Último uso {date}',
      keyNeverUsed: 'Sin usar',
      apiRefTitle: 'Referencia de la API',
      apiRefLead: 'Todas las rutas que una clave puede llamar, con consola de pruebas y la especificación legible por máquinas.',
      apiDocs: 'Referencia interactiva',
      apiOpenApi: 'openapi.json',
      apiRefMissing: 'Esta instalación aún no tiene una dirección pública de la API. Pide a quien la administra que defina API_PUBLIC_URL.',
      connectedTitle: 'Apps conectadas',
      connectedLead:
        'Apps que iniciaron sesión en este espacio de trabajo, como Claude o Cursor. Cada una puede hacer lo que aparece debajo hasta que la desconectes.',
      connectedNone: 'No hay apps conectadas.',
      connectedUnnamed: 'App sin nombre',
      connectedFrom: 'Identificada como {host}',
      connectedApprovedBy: 'Aprobada por {who}',
      connectedSince: 'Conectada el {date}',
      connectedLastUsed: 'Último uso {date}',
      connectedNeverUsed: 'Sin usar todavía',
      connectedRevoke: 'Desconectar',
      connectedRevokeTitle: '¿Desconectar esta app?',
      connectedRevokeBody:
        '«{name}» ya no podrá renovar su acceso. El acceso que ya tiene sigue funcionando hasta {minutes} min y luego se detiene.',
      connectedRevokedToast: 'App desconectada.',
      connectedExpiryNote:
        'Desconectar impide de inmediato que la app renueve su acceso. El acceso que ya tiene se agota en menos de {minutes} min.',
      docsPageLead: 'Para tu propio código: cada ruta que una clave puede llamar, con una consola de prueba y la especificación legible por máquinas.',
      guideSkillTitle: '¿Tu agente no tiene MCP?',
      guideSkillBody:
        'Descarga el skill: un zip que le enseña a cualquier agente con terminal a usar la API de {product} con la misma clave API.',
      guideSkillButton: 'Descargar el skill',
      guideSkillPending: 'Preparando el skill…',
      guideSkillUnavailable: 'El skill no está disponible en esta instalación: todavía no tiene una dirección pública de la API.',
      guideSkillErrorSession: 'Tu sesión terminó. Vuelve a iniciar sesión y descarga el skill.',
      guideSkillErrorForbidden: 'Solo los propietarios y administradores pueden descargar el skill.',
      guideSkillErrorGeneric: 'No se pudo descargar el skill. Inténtalo de nuevo.',
    },
    connect: {
      eyebrow: 'MCP',
      heading: 'Conecta Claude, ChatGPT, Codex o Cursor con {product}',
      intro:
        'Pídele a tu asistente de IA que busque horarios libres, agende, mueva y cancele reuniones y responda solicitudes de reserva, directamente desde un chat. Inicia sesión una vez con tu cuenta y podrá trabajar en todos los espacios donde eres propietario o administrador.',
      signinTitle: 'Conecta con tu cuenta',
      recommended: 'Recomendado',
      signinIntro: 'Elige tu app y sigue los pasos.',
      benefits: {
        noKey: { title: 'Sin clave API.', body: 'Solo inicia sesión con tu cuenta. Nada que crear ni guardar.' },
        workspaces: { title: 'Un conector, todos tus espacios.', body: 'Trabaja en cualquier espacio donde seas propietario o administrador.' },
        access: {
          title: 'Tu acceso, nada más.',
          body: 'Pueden conectarlo propietarios y administradores, y el agente actúa con el acceso de quien lo conectó. Si se quita el rol de administrador, esa conexión se detiene.',
        },
      },
      appsLabel: 'Tu app de IA',
      urlLabel: 'URL del MCP',
      promptLabel: 'Pruébalo',
      prompt: '¿Qué reuniones tengo esta semana en {product}?',
      copy: 'Copiar',
      copied: 'Copiado',
      copyFailed: 'No se pudo copiar. Selecciona el texto y cópialo a mano.',
      copyUrl: 'Copiar URL',
      copyCommand: 'Copiar comando',
      copyConfig: 'Copiar configuración',
      copyPrompt: 'Copiar prompt',
      addToCursor: 'Add to Cursor',
      open: {
        claude: 'Abrir Claude',
        claudeDesktop: 'Abrir Claude Desktop',
        claudeDirectory: 'Abrir en el directorio de Claude',
        newTab: '(se abre en una pestaña nueva)',
        chatgpt: 'Abrir ChatGPT',
        copyCommand: 'Copiar comando',
        copied: 'Copiado',
        pasteHint: 'Pégalo en tu terminal.',
        phoneNote: 'Abre esta página en tu computadora para conectar {app}.',
      },
      apps: {
        claude: {
          steps: [
            {
              title: 'Abre Connectors en Claude',
              body: 'En claude.ai, Claude Desktop o Cowork, haz clic en **+** en la caja del chat y luego en **Connectors → Add connector → Add custom connector**.',
            },
            {
              title: 'Ponle {product} de nombre y pega esta URL',
              body: 'Usa `{product}` como nombre y pega la URL de abajo. Deja vacía la configuración avanzada y haz clic en **Add**.',
            },
            {
              title: 'Inicia sesión con tu cuenta',
              body: 'Tu navegador abre la página de inicio de sesión. Escribe tu correo y el código de 6 dígitos que te enviamos. De vuelta en Claude, {product} aparece como **Connected**.',
            },
            {
              title: 'Pregunta',
              body: 'Abre un chat nuevo y pregunta, por ejemplo:',
            },
          ],
        },
        claudeDirectory: {
          steps: [
            {
              title: 'Abre {product} en el directorio de Claude',
              body: 'Haz clic en el botón de abajo. O, en Claude, haz clic en **+** en la caja del chat, luego en **Connectors → Browse connectors**, y busca `{product}`.',
            },
            {
              title: 'Haz clic en Connect',
              body: 'En la página de {product} del directorio, haz clic en **Connect**. Claude abre el inicio de sesión de {product}.',
            },
            {
              title: 'Inicia sesión con tu cuenta',
              body: 'Escribe tu correo y el código de 6 dígitos que te enviamos. De vuelta en Claude, {product} aparece como **Connected**.',
            },
            {
              title: 'Pregunta',
              body: 'Abre un chat nuevo y pregunta, por ejemplo:',
            },
          ],
          fallbackTitle: '¿Tu organización no deja usar el directorio?',
          fallbackBody:
            'Agrega {product} como conector personalizado: en Claude haz clic en **+** y luego en **Connectors → Add connector → Add custom connector**. Usa `{product}` como nombre, pega esta URL y haz clic en **Add**.',
        },
        chatgpt: {
          steps: [
            {
              title: 'Crea la app en ChatGPT',
              body: 'En la app de escritorio de ChatGPT, cambia a modo **Work**. Abre **Plugins**, haz clic en **Add** y elige **Create MCP App**.',
            },
            {
              title: 'Llena el formulario',
              body: 'Name: `{product}`. Server URL: pega la dirección de abajo. Deja Authentication en **OAuth**. Marca **I understand and want to continue** y créala.',
            },
            {
              title: 'Inicia sesión con tu cuenta',
              body: 'Haz clic en **Continue**. Se abre tu navegador: inicia sesión si te lo pide y luego haz clic en **Open ChatGPT** para volver.',
            },
            {
              title: 'Instala el plugin',
              body: 'En **Plugins**, abre la pestaña **Personal**, elige **{product}** y haz clic en **Install plugin**. El navegador se abre una vez más para vincular tu cuenta: haz clic otra vez en **Open ChatGPT**. Ese segundo inicio de sesión es normal.',
            },
            {
              title: 'Pregunta',
              body: 'Haz clic en **Try now**, escribe `@{product}` y pregunta, por ejemplo:',
            },
          ],
        },
        claudeCode: {
          steps: [
            {
              title: 'Agrega {product} a Claude Code',
              body: 'En una terminal, ejecuta:',
            },
            {
              title: 'Inicia sesión con tu cuenta',
              body: 'Abre Claude Code, ejecuta `/mcp`, elige **{server}** y luego **Authenticate**. Inicia sesión en el navegador y vuelve a la terminal.',
            },
            {
              title: 'Pregunta',
              body: 'Pregunta, por ejemplo:',
            },
          ],
          note: '¿Ya conectaste {product} en Claude? Claude Code con la misma cuenta de Claude también usa ese conector: ejecuta `/mcp` para revisarlo.',
          directoryTitle: '¿Ya conectaste {product} en Claude?',
          directoryBody:
            'Claude Code con la misma cuenta de Claude trae el conector de {product}. Ejecuta `/mcp` y busca **{product}**. ¿Todavía no está? Conéctalo desde el directorio de Claude o sigue los pasos de abajo.',
        },
        codex: {
          steps: [
            {
              title: 'Agrega {product} a Codex',
              body: 'En una terminal, ejecuta:',
            },
            {
              title: 'Inicia sesión con tu cuenta',
              body: 'Ejecuta este comando. Se abre tu navegador: inicia sesión y vuelve a la terminal.',
            },
            {
              title: 'Pregunta',
              body: 'Abre Codex y pregunta, por ejemplo:',
            },
          ],
          note: '¿Usas la app de escritorio de Codex o ChatGPT? Sigue la pestaña **ChatGPT**.',
        },
        cursor: {
          steps: [
            {
              title: 'Agrega {product} a Cursor',
              body: 'Si tienes Cursor instalado, haz clic en **Add to Cursor**. O abre **Customize → MCPs → New MCP Server**, elige **User** y pega esto en `mcp.json`:',
            },
            {
              title: 'Inicia sesión con tu cuenta',
              body: '**{server}** aparece con **Needs authentication**. Haz clic en **Authenticate**, inicia sesión en el navegador, haz clic en **Allow access** y luego en **Open Cursor**.',
            },
            {
              title: 'Pregunta',
              body: 'Abre un **New Chat** y pregunta, por ejemplo. Cursor te pregunta antes de usar una herramienta: haz clic en **Run**.',
            },
          ],
        },
        openclaw: {
          steps: [
            {
              title: 'Agrega {product} a OpenClaw',
              body: 'En una terminal, guarda {product} como servidor MCP remoto que inicia sesión con tu cuenta:',
            },
            {
              title: 'Inicia sesión con tu cuenta',
              body: 'Ejecuta este comando. Se abre tu navegador: inicia sesión y vuelve a la terminal. Después, `openclaw mcp status --verbose` muestra {server} como autorizado.',
            },
            {
              title: 'Pregunta',
              body: 'Pregúntale a tu agente de OpenClaw, por ejemplo:',
            },
          ],
        },
        hermes: {
          steps: [
            {
              title: 'Agrega {product} a Hermes',
              body: 'Abre `~/.hermes/config.yaml` (o ejecuta `hermes config edit`) y agrega {product} dentro de `mcp_servers`:',
            },
            {
              title: 'Inicia sesión con tu cuenta',
              body: 'Ejecuta este comando. Se abre tu navegador: inicia sesión y vuelve a la terminal. Después abre una sesión nueva, o ejecuta `/reload-mcp` en la que tengas abierta.',
            },
            {
              title: 'Pregunta',
              body: 'Pregúntale a tu agente de Hermes, por ejemplo:',
            },
          ],
        },
      },
      tip: '**Un conector para todos tus espacios.** Si eres propietario o administrador en varios, tu app de IA te pregunta en cuál trabajar. Para cambiar, solo di «cambia a <espacio>».',
      stepUpNote:
        'En esta instalación una conexión nueva solo puede leer: la primera vez que le pidas a tu agente agendar, mover o cancelar una reunión, tu app de IA te pide aprobarlo también.',
      unavailableTitle: 'El conector no está disponible en esta instalación',
      unavailableBody:
        'El servidor MCP de esta instalación todavía no acepta inicio de sesión, así que las apps de IA no pueden conectarse aquí. Pídele a quien la administra que active `MCP_ENABLED` y `OAUTH_ENABLED` y configure `MCP_PUBLIC_URL`.',
      media: {
        terminalLabel: 'Animación: cómo conectar {product} en {app}',
        play: 'Reproducir el recorrido',
        pause: 'Pausar el recorrido',
      },
      walkthrough: {
        prompt: 'Busca un horario de 30 minutos el jueves y agéndalo con Sarah Collins',
        ui: {
          ccWelcome: 'Welcome to Claude Code!',
          ccHelp: '/help for help, /status for your current setup',
          ccAdded: 'Added HTTP MCP server {server} with URL: {url} to user config',
          ccManage: 'Manage MCP servers',
          needsAuth: 'needs authentication',
          authenticate: 'Authenticate',
          ccBrowser: 'Opening your browser to authenticate…',
          ccAuthOk: 'Authentication successful. Connected to {server}.',
          codexAdded: "Added global MCP server '{server}'.",
          codexAuthorize: 'Authorize {server} in your browser to continue.',
          codexLoggedIn: "Successfully logged in to MCP server '{server}'.",
          codexModel: 'model: gpt-5-codex  directory: ~/pulse',
          called: 'Called',
          working: 'Working',
          ocSaved: 'Saved MCP server "{server}" (streamable-http, auth: oauth).',
          ocLogin: 'Opening the browser to sign in to {server}…',
          ocLoggedIn: '{server}: authorized. {count} tools available.',
          hmSaved: 'Saved. Run hermes mcp login {server} to sign in.',
          hmLogin: 'Opening your browser to authorize {server}…',
          hmLoggedIn: '{server}: authorized. Tokens saved.',
        },
        signIn: {
          title: 'Inicia sesión con tu cuenta',
          emailLabel: 'Correo',
          email: 'laura@example.com',
          continue: 'Continuar con correo',
          checkEmail: 'Revisa tu correo',
          codeSentTo: 'Escribe el código que enviamos a',
          noCode: '¿No te llegó el código? Puedes pedir otro en 30 segundos.',
          connected: '{product} está conectado a {app}',
          consentTitle: '{app} quiere acceder a tu cuenta',
          redirectNote: 'Después de permitir el acceso, te redirigimos a:',
          warning: 'Esta redirección apunta a una aplicación en tu computadora. Permite el acceso solo si lo iniciaste desde {app}.',
          allow: 'Permitir acceso',
          cancel: 'Cancelar',
        },
        answer: {
          found: 'El jueves tiene estos horarios libres:',
          slots: ['9:30', '10:00', '11:30'],
          booked: 'Agendada',
          meeting: 'Llamada inicial con Sarah Collins',
          when: 'Jueves, de 10:00 a 10:30',
          calendar: 'En el calendario de Laura Mendez, Pulse',
        },
      },
      toolsTitle: 'Qué puedes hacer con el MCP',
      toolsIntro: '{count} herramientas para tus horarios libres, reservas y solicitudes. Pide las cosas con tus palabras: tu app de IA elige la herramienta.',
      toolsLink: 'Ver todas las herramientas',
    },
    tools: {
      title: 'Herramientas',
      intro:
        'Todo lo que tu agente puede hacer en {product} una vez conectado: {count} herramientas. Nunca las llamas tú. Pide con tus palabras y tu agente elige la correcta.',
      askLabel: 'Pide:',
      countOne: '1 herramienta',
      count: '{n} herramientas',
      connectCta: 'Conecta tu agente',
      groups: {
        availability: { title: 'Horarios libres', body: 'Busca horarios libres en tus tipos de evento y con un equipo, los mismos que ofrece tu página de reservas.' },
        booking: { title: 'Reservas nuevas', body: 'Agenda reuniones en tus tipos de evento, en páginas públicas de reserva y con un equipo. El invitado recibe el correo de confirmación.' },
        holds: { title: 'Horarios apartados', body: 'Aparta un horario unos minutos mientras la persona decide, para que nadie más lo tome.' },
        bookings: { title: 'Tus reservas', body: 'Mira tus reuniones, lee sus detalles, muévelas a otro horario o cancélalas.' },
        requests: { title: 'Solicitudes de reserva', body: 'Mira las solicitudes que esperan tu respuesta y acéptalas o recházalas.' },
        account: { title: 'Cuenta y tipos de evento', body: 'Quién está conectado, en qué espacios puedes trabajar, tus tipos de evento y sus enlaces.' },
      },
      items: {
        find_available_slots: { what: 'Mira los horarios libres de un tipo de evento, día por día.', ask: '¿Cuándo estoy libre para una llamada de 30 minutos esta semana?' },
        find_team_slots: { what: 'Mira cuándo un evento de equipo tiene un anfitrión libre, o cuándo está libre todo el equipo.', ask: '¿Cuándo está libre el equipo de ventas para una demo la próxima semana?' },
        book_meeting: { what: 'Agenda un horario en una página pública de reserva y envía el correo al invitado.', ask: 'Agenda a Sarah Collins el jueves a las 10:00 en mi página de llamada inicial' },
        book_team_meeting: { what: 'Agenda con un equipo. Elegimos por ti un anfitrión libre.', ask: 'Agenda la demo de ventas con quien esté libre el martes a las 3:00' },
        create_booking: { what: 'Agenda una reunión en uno de tus tipos de evento para alguien y envíale el correo.', ask: 'Agrega una llamada inicial de 30 minutos con Sarah Collins el jueves a las 10:00' },
        hold_slot: { what: 'Aparta un horario unos 10 minutos mientras la persona decide.', ask: 'Aparta el jueves a las 10:00 mientras lo confirmo con Sarah' },
        list_bookings: { what: 'Mira tus reuniones en un rango de fechas.', ask: '¿Qué reuniones tengo esta semana?' },
        get_booking: { what: 'Abre una reunión y lee lo que escribió el invitado.', ask: '¿Qué escribió Sarah cuando reservó?' },
        reschedule_booking: { what: 'Mueve una reunión a otro horario. Se le avisa al invitado.', ask: 'Mueve mi llamada con Sarah al viernes a las 11:00' },
        cancel_booking: { what: 'Cancela una reunión y avísale al invitado.', ask: 'Cancela mi llamada del viernes a las 4:00 y dile que estoy de viaje' },
        list_pending_bookings: { what: 'Mira las solicitudes de reserva que esperan tu respuesta.', ask: '¿Qué solicitudes de reserva me están esperando?' },
        confirm_booking: { what: 'Acepta una solicitud de reserva y avísale al invitado.', ask: 'Acepta la solicitud del jueves' },
        decline_booking: { what: 'Rechaza una solicitud de reserva, libera su horario y avísale al invitado.', ask: 'Rechaza la solicitud del sábado y avisa que no estaré' },
        whoami: { what: 'Mira a qué espacio está conectado el agente y qué puede hacer ahí.', ask: '¿A qué espacio estás conectado?' },
        list_my_accounts: { what: 'Mira todos los espacios en los que puedes trabajar.', ask: '¿En qué espacios puedes trabajar?' },
        list_event_types: { what: 'Mira tus tipos de evento, personales y de equipo.', ask: '¿Qué tipos de evento tengo?' },
        get_booking_page_link: { what: 'Obtén el enlace donde cualquiera puede reservar un tipo de evento.', ask: 'Dame el enlace de mi llamada inicial' },
      },
    },
    oauthConsent: {
      pageTitle: 'Conectar una app',
      heading: '{client} quiere usar tu espacio de trabajo de {product}',
      unnamed: 'Una app',
      identifiedAs: 'Identificada como {host}',
      returnsTo: 'Después de responder vuelves a {host}.',
      loopbackWarning:
        'Esta app se ejecuta en tu propio computador. Permítela solo si tú mismo iniciaste esta conexión, ahora mismo.',
      workspace: 'Espacio de trabajo',
      signedInAs: 'Sesión iniciada como {who}',
      scopesLead: 'Podrá',
      staysConnected: 'Queda conectada hasta {days} días, o hasta que la desconectes en API y webhooks, en Claves API.',
      shortLived: 'Su acceso dura cerca de una hora; después tendrá que pedirlo de nuevo.',
      approve: 'Permitir',
      deny: 'Rechazar',
      working: 'Un momento…',
      notAdminTitle: 'Solo un propietario o administrador puede conectar apps',
      notAdminBody:
        'Una app conectada actúa por todo el espacio de trabajo, así que debe conectarla un propietario o administrador. Aun así puedes rechazar esta solicitud.',
      expiredTitle: 'Esta solicitud venció',
      expiredBody: 'Vuelve a la app que estabas conectando y empieza de nuevo.',
      errorBody: 'Algo salió mal. Vuelve a la app que estabas conectando e inténtalo de nuevo.',
    },
    integrations: {
      pageLead:
        'Conecta tu CRM una vez para todo el espacio de trabajo. A partir de ahí, cada reserva que alguien acepte aquí se convierte en un contacto y en una reunión sobre ese contacto, automáticamente.',
      loadError: 'No pudimos cargar la conexión actual. Recarga para reintentar.',
      hubspotName: 'HubSpot',
      hubspotDesc:
        'Las reservas aceptadas se convierten en un contacto y una reunión asociada. Los cambios de horario y las cancelaciones actualizan esa misma reunión, nunca crean una segunda.',
      disabledTitle: 'No está habilitado en esta instalación',
      disabledBody:
        'Quien administra esta instalación no ha activado ningún CRM. Pídele que configure CRM_PROVIDER y vuelve.',
      noKeyTitle: 'Todavía no se pueden guardar credenciales aquí',
      noKeyBody:
        'Esta instalación no tiene clave de cifrado, así que un token solo podría guardarse sin proteger. Nos negamos a hacerlo. Pide a quien la administra que configure INTEGRATION_ENCRYPTION_KEY y vuelve.',
      unknownTitle: 'No pudimos comprobar esta conexión',
      unknownBody:
        'Algo falló al leer la configuración de esta instalación, así que no ofrecemos conectar hasta saber que funcionaría. Recarga para reintentar.',
      statusConnected: 'Conectado',
      statusUnhealthy: 'Requiere atención',
      statusDisconnected: 'Desconectado',
      statusNotConnected: 'Sin conectar',
      notConnectedBody: 'Este espacio de trabajo no está enviando nada a HubSpot.',
      endingIn: 'Token terminado en {last4}',
      lastChecked: 'Última comprobación: {date}',
      neverChecked: 'Aún sin usar — la próxima reserva aceptada será la primera comprobación.',
      disconnectedBody:
        'Se eliminó la credencial. Las reservas existentes siguen apuntando a sus reuniones, así que reconectar el mismo portal retoma justo donde quedó.',
      unhealthyLead: 'Las reservas dejaron de llegar a HubSpot.',
      unhealthyScopes: 'HubSpot indica que a tu aplicación privada le faltan estos permisos:',
      unhealthyKeepsCredential:
        'El token sigue aquí. Concede los permisos en HubSpot y la próxima reserva aceptada pasará sola — no hay nada que volver a pegar.',
      unhealthyUnknown: 'HubSpot rechazó la última escritura y no dijo por qué.',
      connect: 'Conectar',
      connecting: 'Conectando…',
      reconnect: 'Reconectar',
      disconnect: 'Desconectar',
      disconnecting: 'Desconectando…',
      disconnectConfirm: '¿Dejar de enviar reservas a HubSpot?',
      disconnectNothingDeleted:
        'No se borra nada dentro de HubSpot. Los contactos y las reuniones que ya están ahí se quedan tal cual.',
      confirmDisconnect: 'Sí, desconectar',
      cancel: 'Cancelar',
      dialogTitle: 'Conectar HubSpot',
      dialogLead:
        'En HubSpot, abre Configuración, luego Integraciones y luego Aplicaciones privadas, y crea una aplicación. Concédele los dos permisos de abajo y pega aquí su token de acceso.',
      scopesTitle: 'Permisos que necesita la aplicación',
      scopesLead: 'Marca cada uno a medida que lo concedes en HubSpot. Todos son obligatorios.',
      tokenLabel: 'Token de acceso',
      tokenPlaceholder: 'Pega el token de la aplicación privada',
      tokenHelp:
        'Comprobamos el token con HubSpot antes de guardarlo, y no volvemos a mostrarlo nunca más.',
      labelLabel: 'Nombre del portal (opcional)',
      labelPlaceholder: 'p. ej. Portal de ventas de Acme',
      labelHelp: 'Solo para reconocer esta conexión más adelante.',
      errorRejected:
        'HubSpot rechazó ese token. Comprueba que la aplicación privada esté activa y tenga los dos permisos.',
      errorMissingScopes: 'HubSpot indica que faltan estos permisos:',
      errorUnverified:
        'No pudimos contactar con HubSpot para comprobar ese token. Inténtalo de nuevo en un momento.',
      errorNoKey:
        'Esta instalación no puede guardar credenciales: no hay clave de cifrado configurada.',
      errorDisabled: 'No hay ningún CRM habilitado en esta instalación.',
      errorGeneric: 'Algo salió mal. Inténtalo de nuevo.',
      nothingStored: 'No se guardó nada.',
      connectedToast: 'HubSpot conectado.',
      disconnectedToast: 'HubSpot desconectado.',
    },
    brandKit: {
      title: 'Kit de marca',
      statement: 'Un solo estilo para todas las páginas de tu espacio.',
      statusSet: 'Guardado',
      statusUnset: 'Sin definir',
      logo: 'Logo',
      logoHint: 'Se muestra arriba del panel del evento y sobre la portada del perfil, tal como la subes: usa una versión que se lea sobre tu fondo.',
      accent: 'Color de acento',
      accentHint: 'Botones, el día y la hora elegidos, enlaces.',
      canvas: 'Fondo',
      canvasHint: 'El fondo sobre el que se pinta la página.',
      font: 'Fuente',
      corners: 'Esquinas',
      buttons: 'Botones',
      cardStyle: 'Estilo de tarjeta',
      shapeHint: 'La plantilla, la densidad y cómo se listan los horarios siguen siendo de cada página.',
      keepPageOwn: 'Mantener el de cada página',
      save: 'Guardar kit',
      saving: 'Guardando…',
      saved: 'Kit de marca guardado.',
      saveFailed: 'No se pudo guardar el kit de marca.',
      readOnly: 'Solo un administrador o propietario puede cambiar el kit de marca.',
      preview: 'Vista previa',
      previewHint: 'Una página de reservas con este kit.',
      howItWorks: 'Cómo llega a una página',
      howItWorksBody: 'Cada anfitrión aplica el kit desde el estudio de su página de reservas; se copia en su página y se puede revertir una vez. Editar el kit después nunca cambia una página por sí solo. Las páginas de equipo usan el kit directamente.',
      updatedOn: 'Actualizado el {date}',
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
      saveTooLarge: 'Demasiado grande para guardar. Vuelve a subir tu foto o portada e inténtalo de nuevo.',
      profile: 'Perfil',
      brand: 'Marca',
      appearance: 'Apariencia',
      meetings: 'Reuniones',
      displayName: 'Nombre visible',
      publicHandle: 'Identificador público',
      yourLink: 'Tu enlace de reservas',
      linkCopy: 'Copiar',
      linkCopied: 'Copiado \u2713',
      linkOpen: 'Abrir',
      vanityLabel: 'Enlace personalizado (vanity)',
      vanityHint: 'Incluido con tu suscripción de Dapta AI. De 3 a 30 letras minúsculas, números o guiones; tu código corto sigue funcionando.',
      vanityIncluded: 'Los enlaces personalizados están incluidos con tu suscripción de Dapta AI.',
      vanityIncludedLink: 'Saber más',
      bio: 'Biografía',
      tryHandle: 'Prueba {handle}',
      accent: 'Color de acento',
      contrast: 'Contraste del texto {ratio}:1',
      lowContrast:
        'Contraste bajo: {ratio}:1 sobre el fondo de tu página. Los enlaces y botones pueden ser difíciles de leer. Tu color se usa tal como lo elegiste.',
      photoAvatar: 'Foto / avatar',
      photoFromConnectedAccount:
        'Tu página muestra la foto de tu calendario conectado. Sube una para usar la tuya.',
      connectedPhotoHidden: 'La foto de tu calendario conectado está desactivada. Tu página muestra tus iniciales.',
      removeConnectedPhoto: 'Quitar',
      useConnectedPhoto: 'Usarla de nuevo',
      coverImage: 'Imagen de portada',
      custom: 'Personalizado',
      customizeAppearance: 'Personalizar apariencia',
      newLook: 'Usar el nuevo estilo',
      newLookHint: 'Tinta sobre papel y el conjunto mínimo, el estilo con el que empiezan las páginas nuevas. Lo ves aquí primero.',
      newLookPreviewing: 'Vista previa del nuevo estilo. Guarda para ponerlo en tu página; después puedes revertirlo.',
      newLookApplied: 'Nuevo estilo aplicado el {date}.',
      kitApplied: 'Kit de marca aplicado el {date}.',
      revertLook: 'Revertir',
      revertingLook: 'Revirtiendo…',
      lookReverted: 'Tu estilo anterior está de vuelta.',
      revertFailed: 'No se pudo revertir. Inténtalo de nuevo.',
      tabYourPage: 'Tu página',
      tabBrandKit: 'Kit de marca',
      applyKit: 'Aplicar kit de marca',
      applyingKit: 'Aplicando…',
      applyKitHint: 'El logo, los colores, la fuente y la forma de tu espacio de trabajo, copiados en esta página. Puedes revertirlo una vez.',
      kitAppliedToast: 'Kit de marca aplicado a tu página.',
      applyKitFailed: 'No se pudo aplicar el kit de marca. Inténtalo de nuevo.',
      applyKitSaveFirst: 'Guarda o descarta tus cambios antes de aplicar el kit.',
      axisTemplate: 'Plantilla',
      axisCardStyle: 'Estilo de tarjeta',
      axisCorners: 'Esquinas',
      axisButtons: 'Botones',
      axisDensity: 'Densidad',
      axisFont: 'Fuente',
      axisSlotLayout: 'Disposición de horarios',
      axisDayGroup: 'Agrupación por día',
      axisSlotSelect: 'Selección de horario',
      axisTheme: 'Tema',
      themeLight: 'Claro',
      themeDark: 'Oscuro',
      show: 'Mostrar',
      hide: 'Ocultar',
      noEvents: 'Aún no hay eventos.',
      orderVisibilityNote: 'El orden y la visibilidad se aplican a tu página pública.',
      configureEventTypes: 'Configurar eventos',
      showLandingPage: 'Mostrar la página de inicio (lista de eventos)',
      sendVisitorsTo: 'Enviar a los visitantes directamente a',
      chooseEvent: 'Elige un evento…',
      pickDefaultEvent: 'Elige un evento predeterminado o deja activa la página de inicio.',
      linkOpensEvent: 'Tu enlace abre {event} directamente.',
      linkOpensProfile: 'Tu enlace abre tu perfil.',
      alwaysShowProfile: 'Mostrar siempre mi perfil, aunque tenga un solo tipo de evento',
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
      available: 'Disponible',
      taken: 'Ocupado',
      invalid: 'No válido (3–40 caracteres, a–z 0–9 -)',
      uploadImage: 'Subir imagen',
      clear: 'Quitar',
      orPasteUrl: '…o pega una URL de imagen',
      imageInvalid: 'Elige un archivo de imagen.',
      imageTooLarge: 'Esa imagen es demasiado grande para abrirse. Elige una de menos de 25MB.',
      imageWorking: 'Redimensionando…',
      imageCannotShrink: 'No se puede reducir esa imagen lo suficiente para guardarla. Prueba con otra.',
      imageHelp:
        'Las fotos grandes se redimensionan automáticamente; de un GIF animado solo se conserva el primer fotograma.',
      couldNotRead: 'No se pudo leer el archivo.',
      introCall: 'Llamada de introducción',
      minSuffix: 'min',
    },
  },
  onboarding: {
    qualifyTitle: 'Cuéntanos sobre tu trabajo',
    qualifySubtitle: 'Un par de preguntas para configurar todo según cómo agendas en realidad.',
    questions: {
      phone: 'Número de teléfono',
      industry: '¿En qué industria trabajas?',
      crm: '¿Qué CRM usa tu equipo?',
      lead_volume: '¿Cuántos leads nuevos manejas al mes?',
      lead_source: '¿De dónde vienen la mayoría de tus leads?',
      use_case: '¿Para qué vas a usar la agenda?',
    },
    templateTitle: 'Crea tu primer evento',
    templateSubtitle: 'Elige un punto de partida. Luego puedes renombrarlo, cambiar la duración o agregar más.',
    template30MinTitle: 'Reunión de 30 minutos',
    template30MinDesc: 'La opción por defecto para la mayoría de las conversaciones.',
    template15MinTitle: 'Llamada rápida',
    template15MinDesc: 'Para seguimientos cortos y presentaciones.',
    template45MinTitle: 'Demo',
    template45MinDesc: 'Espacio suficiente para mostrar algo con calma.',
    template60MinTitle: 'Reunión 1:1',
    template60MinDesc: 'Una hora completa para conversaciones más profundas.',
    intakeTopic: '¿Qué te gustaría conversar?',
    intakeCompany: 'Empresa',
    minutes: '{minutes} min',
    continueLabel: 'Continuar',
    saving: 'Guardando…',
    finish: 'Crear evento y terminar',
    finishing: 'Creando…',
    skipForNow: 'Ahora no',
    errorGeneric: 'Algo salió mal. Inténtalo de nuevo.',
  },
  crm: {
    hostLabel: 'Anfitrión',
    bookingReferenceLabel: 'Referencia de la reserva',
    yes: 'Sí',
    no: 'No',
    cancelledTitlePrefix: '[Cancelada] ',
  },
  embed: {
    action: 'Insertar en tu sitio',
    title: 'Insertar en tu sitio',
    intro: 'Pega esto donde quieras que aparezca la página de reservas. Se ajusta de alto solo, y la página de reservas se carga igual aunque este script quede bloqueado.',
    snippetLabel: 'Código para insertar',
    copy: 'Copiar código',
    copied: 'Copiado',
    close: 'Listo',
    accentLabel: 'Color de acento',
    accentInherit: 'Usar el estilo de mi página de reservas',
    accentCustom: 'Elegir un color para esta inserción',
    resizeNote: 'El marco crece y se reduce con la página, así que no necesitas fijar una altura.',
    advancedNote: 'Para cambiar más el aspecto, agrega cualquiera de estos a la dirección insertada: template, card_style, corners, buttons, density, font, slot_layout, day_group, slot_select. Un valor que no reconozcamos se ignora.',
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

/**
 * Localized display name for an event type's scheduling_type. Null/personal
 * events (no team method) fall back to `personal`; unknown values echo through.
 */
export function schedulingMethodLabel(
  m: BookingMessages,
  type: string | null | undefined,
  personal = 'Personal',
): string {
  if (!type) return personal;
  if (type === 'round_robin' || type === 'collective' || type === 'fixed_round_robin') {
    return m.scheduling[type];
  }
  return type;
}
