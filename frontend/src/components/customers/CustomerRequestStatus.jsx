import { useEffect, useState } from "react";
import {
  FaClipboardList,
  FaClock,
  FaCheckCircle,
  FaTimesCircle,
  FaCashRegister,
  FaPaw,
  FaBan,
} from "react-icons/fa";
import "./CustomerRequestStatus.css";
import { apiRequest } from "../../api/client";
import { normalizeList } from "../../utils/normalizeList";
import { showSuccess, showError, showReasonPrompt, CUSTOMER_CANCEL_REASONS } from "../../utils/alert.jsx";
import { useAuth } from "../../context/AuthContext";
import PaymentUploadModal from "../shared/PaymentUploadModal";
import RowActionPopover from "../shared/RowActionPopover"

const safeLower = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.toLowerCase();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).toLowerCase();
  }
  return "";
};

const safeText = (value, fallback = "N/A") => {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
};

const getCustomerName = (item) =>
  safeText(item?.customer_name || item?.customer?.name || item?.customer?.email || item?.customer, "N/A");

const getPetName = (item) =>
  safeText(item?.pet_name || item?.pet?.name || item?.pet, "N/A");

const CustomerRequestStatus = ({ embedded = false }) => {
  const { user } = useAuth();
  const [requests, setRequests] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [uploadModal, setUploadModal] = useState({ open: false, endpoint: "", title: "", referenceNumber: "", paymentStatus: "", rejectionReason: "", paymentMethod: "gcash" });

  useEffect(() => {
    fetchRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchRequests = async () => {
    try {
      const email = user?.email;

      if (!email) {
        setRequests([]);
        return;
      }

      const [requestsData, ordersData, boardingsData] = await Promise.all([
        apiRequest(`/customer/my-requests?email=${encodeURIComponent(email)}`).catch(() => []),
        apiRequest("/customer/store/orders").catch(() => []),
        apiRequest("/customer/boarding-requests").catch(() => []),
      ]);

      const serviceRequests = normalizeList(requestsData, ["requests", "service_requests", "grooming_requests"]).map((item) => ({
        ...item,
        source: "service_request",
        type_label: item.service_name || item.service || item.request_type || "Service Request",
      }));
      const orders = normalizeList(ordersData, ["orders", "data"]).map((item) => ({
        ...item,
        source: "store_order",
        type_label: item.order_number || "Store Order",
        service_name: item.order_name || "Store Order",
      }));
      const boardings = normalizeList(boardingsData, ["boarding_requests", "boardings", "data"]).map((item) => ({
        ...item,
        source: "boarding",
        type_label: item.room?.name || item.hotel_room?.name || "Pet Hotel / Boarding",
        service_name: item.room?.name || item.hotel_room?.name || "Pet Hotel / Boarding",
      }));

      setRequests(normalizeList([...serviceRequests, ...orders, ...boardings]));
    } catch {
      setRequests([]);
    }
  };

  const getSortDate = (item) => {
    const raw = item.check_in || item.check_in_date || item.preferred_date || item.scheduled_date || item.date || item.request_date || item.created_at;
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  };

  const filteredRequests = Array.isArray(requests)
    ? requests
        .filter((item) => {
          const search = safeLower(searchTerm);
          const status = safeLower(item?.status || item?.order_status);

          const searchableText = [
            item?.service_type,
            item?.type,
            item?.type_label,
            getCustomerName(item),
            item?.customer_email,
            getPetName(item),
            item?.pet_type,
            item?.service,
            item?.service_name,
            item?.preferred_date,
            item?.scheduled_date,
            item?.date,
            item?.request_date,
            item?.id,
            status,
          ]
            .map(safeLower)
            .join(" ");

          return !search || searchableText.includes(search);
        })
        .sort((a, b) => {
          const dateA = getSortDate(a);
          const dateB = getSortDate(b);
          const today = new Date();
          today.setHours(0, 0, 0, 0);

          if (!dateA && !dateB) return 0;
          if (!dateA) return 1;
          if (!dateB) return -1;

          const diffA = Math.abs(dateA.getTime() - today.getTime());
          const diffB = Math.abs(dateB.getTime() - today.getTime());

          return diffA - diffB;
        })
    : [];

  const getStatusIcon = (status) => {
    const normalizedStatus = safeLower(status);
    if (normalizedStatus === "approved") return <FaCheckCircle />;
    if (normalizedStatus === "rejected") return <FaTimesCircle />;
    return <FaClock />;
  };

  const canPay = (item) => {
    if (item?.source === "store_order") return false;
    const status = safeLower(item?.status || item?.order_status);
    const paymentStatus = safeLower(item?.payment_status || item?.payment || "unpaid");
    return ["approved", "scheduled"].includes(status) && ["unpaid", "rejected"].includes(paymentStatus);
  };

  const canCancelBoarding = (item) =>
    item.source === "boarding" && safeLower(item?.status) === "pending";

  const openUploadModal = (item) => {
    let endpoint = "";
    if (item.source === "store_order")
      endpoint = `/customer/store/orders/${item.id}/payment-proof`;
    else if (item.source === "boarding")
      endpoint = `/customer/boarding-requests/${item.id}/payment-proof`;
    else
      endpoint = `/customer/requests/${item.id}/payment-proof`;
    setUploadModal({
      open: true,
      endpoint,
      title: item.type_label || "Service",
      referenceNumber: item.payment_reference || item.reference_number || "",
      paymentStatus: safeLower(item.payment_status || item.payment),
      rejectionReason: item.rejection_reason || "",
      paymentMethod: item.payment_method || "gcash",
    });
  };

  const cancelBoarding = async (item) => {
    const reason = await showReasonPrompt(
      "Please tell us why you're cancelling this boarding request.",
      "Cancel Boarding Request",
      "Cancel Request",
      CUSTOMER_CANCEL_REASONS
    );
    if (!reason) return;
    try {
      await apiRequest(
        `/customer/boarding-requests/${item.id}/cancel`,
        "POST",
        { cancellation_reason: reason }
      );
      showSuccess("Boarding request cancelled successfully.");
      fetchRequests();
    } catch (err) {
      showError(err.message || "Failed to cancel boarding request.");
    }
  };

  return (
    <div className={`customer-status-page${embedded ? " embedded" : ""}`}>
      <section className="customer-status-toolbar">
        <div className="customer-status-search">
          <input
            type="text"
            placeholder="Search request, pet, or service..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </section>

      <section className="customer-status-table-wrap">
        {filteredRequests.length === 0 ? (
          <div className="customer-status-empty">
            <FaClipboardList />
            <h3>No requests found</h3>
            <p>Your booking requests will appear here after submission.</p>
          </div>
        ) : (
          <table className="customer-status-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Service</th>
                <th>Pet</th>
                <th>Date</th>
                <th>Status</th>
                <th>Payment</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredRequests.map((item) => {
                const status = safeText(item.status || item.order_status, "pending");
                const paymentStatus = safeText(item.payment_status || item.payment, "unpaid");

                return (
                  <tr key={`${item.source || "request"}-${item.id}`}>
                    <td className="col-id">#{item.id}</td>
                    <td className="col-service">{safeText(item.service || item.service_name || item.type_label, "Service Request")}</td>
                    <td className="col-pet">{getPetName(item)}</td>
                    <td className="col-date">
                      {(item.date || item.request_date) ? new Date(item.date || item.request_date).toLocaleDateString() : "N/A"}
                    </td>
                    <td className="col-status">
                      <span className={`customer-status-pill ${safeLower(status)}`}>
                        {getStatusIcon(status)}
                        {status}
                      </span>
                    </td>
                    <td className="col-payment">
                      <span className={`customer-payment-pill ${safeLower(paymentStatus)}`}>
                        <FaCashRegister />
                        {paymentStatus}
                      </span>
                      {safeLower(paymentStatus) === "rejected" && item.rejection_reason && (
                        <small className="customer-payment-rejection">Reason: {item.rejection_reason}</small>
                      )}
                    </td>
                    <td className="col-action">
                      {canPay(item) || canCancelBoarding(item) ? (
                        <RowActionPopover rowLabel={`${getCustomerName(item)} ${getPetName(item)}`}>
                          <div className="col-action-buttons">
                            {canPay(item) && (
                              <button
                                className="customer-pay-btn"
                                onClick={() => openUploadModal(item)}
                              >
                                Pay
                              </button>
                            )}
                            {canCancelBoarding(item) && (
                              <button
                                className="customer-cancel-btn"
                                onClick={() => cancelBoarding(item)}
                                title="Cancel boarding request"
                              >
                                <FaBan /> Cancel
                              </button>
                            )}
                          </div>
                        </RowActionPopover>
                      ) : <span className="no-action">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <PaymentUploadModal
        open={uploadModal.open}
        onClose={() => setUploadModal({ open: false, endpoint: "", title: "", referenceNumber: "", paymentStatus: "", rejectionReason: "", paymentMethod: "gcash" })}
        onSuccess={fetchRequests}
        endpoint={uploadModal.endpoint}
        title={uploadModal.title}
        referenceNumber={uploadModal.referenceNumber}
        paymentStatus={uploadModal.paymentStatus}
        rejectionReason={uploadModal.rejectionReason}
        paymentMethod={uploadModal.paymentMethod}
      />
    </div>
  );
};

export default CustomerRequestStatus;
