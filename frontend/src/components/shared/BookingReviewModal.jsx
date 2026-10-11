import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faXmark,
  faPaw,
  faCalendarCheck,
  faFileInvoice,
  faNoteSticky,
  faSyringe,
  faFileLines,
  faSpinner,
} from "@fortawesome/free-solid-svg-icons";
import "./BookingReviewModal.css";

/**
 * Shared booking review modal — shown before any booking is submitted so the
 * customer can confirm pet, schedule, room, pricing, notes, and the uploaded
 * vaccination card.
 *
 * Props:
 *   open        - boolean
 *   onClose     - go back / dismiss
 *   onConfirm   - perform the actual submit
 *   loading     - submit in progress
 *   badge       - service type chip label ("Grooming", "Pet Hotel", ...)
 *   title       - heading text (defaults to "Review your booking")
 *   pet         - { name, species, breed, age } | null
 *   details     - [{ label, value }] booking detail rows
 *   pricing     - { rows: [{ label, value }], total } | null
 *   notes       - string | null
 *   attachment  - { name, previewUrl, isImage } | null (vaccination card)
 */
export default function BookingReviewModal({
  open,
  onClose,
  onConfirm,
  loading = false,
  badge,
  title = "Review your booking",
  pet,
  details = [],
  pricing,
  notes,
  attachment,
}) {
  if (!open) return null;

  const detailRows = details.filter((d) => d.value != null && d.value !== "");

  return (
    <div className="brm-overlay" onClick={loading ? undefined : onClose}>
      <div className="brm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="brm-header">
          <div>
            {badge && <span className="brm-badge">{badge}</span>}
            <h3 className="brm-title">{title}</h3>
          </div>
          <button type="button" className="brm-close" onClick={onClose} disabled={loading}>
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>

        <div className="brm-body">
          {pet && (
            <section className="brm-section">
              <h4 className="brm-section-title">
                <FontAwesomeIcon icon={faPaw} /> Pet
              </h4>
              <div className="brm-pet">
                <span className="brm-pet-name">{pet.name}</span>
                <span className="brm-pet-meta">
                  {[pet.species, pet.breed, pet.age].filter(Boolean).join(" · ")}
                </span>
              </div>
            </section>
          )}

          {detailRows.length > 0 && (
            <section className="brm-section">
              <h4 className="brm-section-title">
                <FontAwesomeIcon icon={faCalendarCheck} /> Booking Details
              </h4>
              <div className="brm-rows">
                {detailRows.map((row) => (
                  <div className="brm-row" key={row.label}>
                    <span className="brm-label">{row.label}</span>
                    <span className="brm-value">{row.value}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {pricing && (
            <section className="brm-section">
              <h4 className="brm-section-title">
                <FontAwesomeIcon icon={faFileInvoice} /> Pricing Summary
              </h4>
              <div className="brm-pricing">
                {pricing.rows.map((row) => (
                  <div className="brm-row" key={row.label}>
                    <span className="brm-label">{row.label}</span>
                    <span className="brm-value">{row.value}</span>
                  </div>
                ))}
                <div className="brm-row brm-total">
                  <span>Total</span>
                  <span>{pricing.total}</span>
                </div>
              </div>
            </section>
          )}

          {attachment && (
            <section className="brm-section">
              <h4 className="brm-section-title">
                <FontAwesomeIcon icon={faSyringe} /> Vaccination Card
              </h4>
              {attachment.isImage && attachment.previewUrl ? (
                <img className="brm-attachment-img" src={attachment.previewUrl} alt="Vaccination card" />
              ) : (
                <div className="brm-attachment-file">
                  <FontAwesomeIcon icon={faFileLines} />
                  <span>{attachment.name}</span>
                </div>
              )}
            </section>
          )}

          {notes ? (
            <section className="brm-section">
              <h4 className="brm-section-title">
                <FontAwesomeIcon icon={faNoteSticky} /> Notes
              </h4>
              <p className="brm-notes">{notes}</p>
            </section>
          ) : null}
        </div>

        <div className="brm-footer">
          <button type="button" className="brm-btn brm-ghost" onClick={onClose} disabled={loading}>
            Go back
          </button>
          <button type="button" className="brm-btn brm-primary" onClick={onConfirm} disabled={loading}>
            {loading && <FontAwesomeIcon icon={faSpinner} spin />}
            {loading ? "Submitting..." : "Confirm booking"}
          </button>
        </div>
      </div>
    </div>
  );
}
