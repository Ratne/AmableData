import type { MembersMessageKey } from './members-en';

/** Italian strings of the members & roles page — must cover every key of members-en. */
export const membersIt: Readonly<Record<MembersMessageKey, string>> = {
  'members.intro':
    'Le persone che hanno accesso a questo spazio di lavoro e cosa può fare ogni ruolo.',
  'members.noAccess': 'Non hai accesso a questa pagina.',
  'members.invite': 'Invita utente',
  'members.inviteTitle': 'Invita un utente',
  'members.inviteHint':
    'Riceverà un’email con il link per entrare. L’invito scade dopo qualche giorno.',
  'members.inviteSend': 'Invia invito',
  'members.invited': 'Invito inviato a {email}',
  'members.email': 'Email',
  'members.role': 'Ruolo',
  'members.listTitle': 'Membri',
  'members.name': 'Nome',
  'members.since': 'Membro dal',
  'members.you': 'Tu',
  'members.remove': 'Rimuovi',
  'members.removeTitle': 'Rimuovi membro',
  'members.removeConfirm': '{name} perderà subito l’accesso a questo spazio di lavoro.',
  'members.removed': 'Membro rimosso',
  'members.roleChanged': 'Ruolo aggiornato',
  'members.lastOwnerHint': 'L’ultimo proprietario non può essere modificato né rimosso.',
  'members.invitesTitle': 'Inviti in attesa',
  'members.invitesEmpty': 'Nessun invito in attesa.',
  'members.sent': 'Inviato',
  'members.expires': 'Scade',
  'members.revoke': 'Revoca',
  'members.revokeTitle': 'Revoca invito',
  'members.revokeConfirm': 'Il link d’invito inviato a {email} smetterà di funzionare.',
  'members.revoked': 'Invito revocato',
  'members.rolesTitle': 'Ruoli',
  'members.roleDesc.owner':
    'Tutto, compresi fatturazione, trasferimento della proprietà ed eliminazione dello spazio di lavoro.',
  'members.roleDesc.admin':
    'Tutto tranne fatturazione, trasferimento ed eliminazione; non può modificare né rimuovere i proprietari.',
  'members.roleDesc.marketer':
    'Contatti, marketing (email, automazioni, moduli, pagine, prenotazioni) e analitica; vendite ed e-commerce in sola lettura, nessuna impostazione.',
  'members.roleDesc.sales':
    'Contatti, opportunità, attività, prenotazioni, ordini manuali e abbonamenti, email singole e report vendite; niente esportazioni massive.',
  'members.roleDesc.analyst':
    'Legge tutto, crea report e dashboard ed esporta CSV; non modifica mai i dati.',
  'members.roleDesc.viewer':
    'Sola lettura ovunque, report compresi: non crea report e non esporta, campi sensibili nascosti.',
  'members.leave': 'Lascia lo spazio di lavoro',
  'members.leaveTitle': 'Lasciare questo spazio di lavoro?',
  'members.leaveConfirm': 'Perderai l’accesso a {tenant} finché qualcuno non ti inviterà di nuovo.',
  'members.leaveHint': 'Rimuove il tuo accesso a questo spazio di lavoro.',
  'members.left': 'Hai lasciato lo spazio di lavoro',
  'members.error.lastOwner': 'Deve restare almeno un proprietario',
  'members.error.forbidden': 'Non puoi gestire questo ruolo',
  'members.error.stepUp': 'Serve la conferma con il secondo fattore',
  'members.error.rateLimited': 'Troppi inviti: riprova più tardi',
  'members.error.notFound': 'Non esiste più: l’elenco è stato aggiornato',
  'audit.hint': 'Modifiche fatte in questo workspace: membri, ruoli, chiavi API, app, impostazioni e dati, dal più recente. Accessi ed eventi di sicurezza dell’account appartengono all’account di ogni persona e non compaiono qui. Le voci non contengono mai segreti.',
  'audit.empty': 'Ancora nessuna voce registrata.',
  'audit.more': 'Carica voci precedenti',
  'audit.col.when': 'Quando',
  'audit.col.actor': 'Chi',
  'audit.col.action': 'Azione',
  'audit.col.target': 'Oggetto',
  'audit.col.details': 'Dettagli',
  'audit.col.ip': 'IP',
  'audit.actor.system': 'Sistema',
  'audit.actor.apiKey': 'Chiave API',
  'audit.actor.app': 'App {app}',
};
