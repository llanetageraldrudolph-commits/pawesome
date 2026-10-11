import React, { useCallback, useEffect, useMemo, useState } from "react";
import Swal from "sweetalert2";
import { showReasonPrompt, ORDER_REASONS } from "../../utils/alert.jsx";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBan,
  faCalendarAlt,
  faCheckCircle,
  faClipboardList,
  faDownload,
  faEnvelope,
  faEye,
  faMoneyBillWave,
  faReceipt,
  faRefresh,
  faSearch,
  faShoppingCart,
  faSpinner,
  faTimes,
  faTimesCircle,
  faTruck,
  faUser,
  faWallet,
} from "@fortawesome/free-solid-svg-icons";
import "./ReceptionistCustomerOrders.css";
import { apiRequest } from "../../api/client";
import RowActionPopover from "../shared/RowActionPopover";
import { exportToCSV, exportToPDF, exportToExcel } from "../../utils/reportExport";

const STATUS_OPTIONS = [
  { value: "all", label: "All Status" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "paid", label: "Paid" },
  { value: "preparing", label: "Preparing" },
  { value: "completed", label: "Completed" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
];

const PAYMENT_STATUS_OPTIONS = [
  { value: "all", label: "All Payment Status" },
  { value: "unpaid", label: "Unpaid" },
  { value: "pending", label: "Payment Pending" },
  { value: "paid", label: "Paid" },
  { value: "rejected", label: "Payment Rejected" },
];

const normalizeList = (result, keys = []) => {
  if (Array.isArray(result)) return result;

  for (const key of keys) {
    if (Array.isArray(result?.[key])) return result[key];
    if (Array.isArray(result?.data?.[key])) return result.data[key];
    if (Array.isArray(result?.[key]?.data)) return result[key].data;
    if (Array.isArray(result?.data?.[key]?.data)) return result.data[key].data;
  }

  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.data?.data)) return result.data.data;
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result?.orders)) return result.orders;
  if (Array.isArray(result?.customer_orders)) return result.customer_orders;

  return [];
};

const normalizeStatus = (value) =>
  String(value || "pending").toLowerCase().replace(/\s+/g, "_");

const normalizePaymentStatus = (value) =>
  String(value || "unpaid").toLowerCase().replace(/\s+/g, "_");

const formatLabel = (value) =>
  String(value || "N/A")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const formatCurrency = (value) => {
  const amount = Number(value || 0);

  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
  }).format(amount);
};

const formatDate = (value) => {
  if (!value) return "N/A";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";

  return date.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
};

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };

    return map[char];
  });

const getOrderNumber = (order) =>
  order?.order_number || order?.reference_number || order?.id || "N/A";

const getCustomerName = (order) =>
  order?.customer_name || order?.customer?.name || "Unknown Customer";

const getCustomerEmail = (order) =>
  order?.customer_email || order?.customer?.email || "No email";

const isStockAvailable = (item) => {
  if (item?.stock_available !== undefined) return Boolean(item.stock_available);

  const currentStock = Number(item?.current_stock ?? item?.stock ?? item?.available_stock ?? 0);
  const requiredQty = Number(item?.quantity || 0);

  if (currentStock === 0 && requiredQty === 0) return true;

  return currentStock >= requiredQty;
};

const extractOrderDetail = (result) => {
  if (result?.success === false) {
    throw new Error(result?.message || "Failed to fetch order details.");
  }

  return result?.data || result?.order || result;
};

export default function ReceptionistCustomerOrders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [updatingId, setUpdatingId] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  const [selectedOrder, setSelectedOrder] = useState(null);
  const [detailsModalOpen, setDetailsModalOpen] = useState(false);

  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState("all");
  const [lastUpdated, setLastUpdated] = useState("");

  const [showExportDropdown, setShowExportDropdown] = useState(false);

  const fetchOrders = useCallback(
    async ({ silent = false } = {}) => {
      try {
        if (silent) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }

        const params = new URLSearchParams();

        if (statusFilter !== "all") {
          params.append("status", statusFilter);
        }

        if (paymentStatusFilter !== "all") {
          params.append("payment_status", paymentStatusFilter);
        }

        const endpoint = `/receptionist/customer-orders${
          params.toString() ? `?${params.toString()}` : ""
        }`;

        const data = await apiRequest(endpoint);
        const list = normalizeList(data, ["data", "orders", "customer_orders"]);

        setOrders(list);
        setLastUpdated(new Date().toLocaleString("en-PH"));
      } catch (err) {
        Swal.fire({
          icon: "error",
          title: "Failed to load orders",
          text: err.message || "Unable to load customer orders.",
          confirmButtonColor: "#ff5f93",
        });
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [statusFilter, paymentStatusFilter]
  );

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const filteredOrders = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();

    return orders.filter((order) => {
      if (!keyword) return true;

      const searchableText = [
        order.id,
        order.order_number,
        order.reference_number,
        order.customer_name,
        order.customer_email,
        order.order_type,
        order.status,
        order.payment_status,
        order.payment_method,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return searchableText.includes(keyword);
    });
  }, [orders, searchTerm]);

  const stats = useMemo(() => {
    return {
      total: orders.length,
      pending: orders.filter((order) => normalizeStatus(order.status) === "pending").length,
      approved: orders.filter((order) => normalizeStatus(order.status) === "approved").length,
      paid: orders.filter(
        (order) =>
          normalizeStatus(order.status) === "paid" ||
          normalizePaymentStatus(order.payment_status) === "paid"
      ).length,
      rejected: orders.filter((order) => normalizeStatus(order.status) === "rejected").length,
      cancelled: orders.filter((order) => normalizeStatus(order.status) === "cancelled").length,
      totalAmount: orders.reduce((sum, order) => sum + Number(order.total_amount || 0), 0),
    };
  }, [orders]);

  const postOrderAction = async (endpoint, body = null) => {
    const options = {
      method: "POST",
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const result = await apiRequest(endpoint, options);

    if (result?.success === false) {
      throw new Error(result?.message || "Action failed.");
    }

    return result;
  };

  const getOrderDetails = async (orderId) => {
    const result = await apiRequest(`/receptionist/customer-orders/${orderId}`);
    return extractOrderDetail(result);
  };

  const approveOrder = async (orderId) => {
    try {
      setUpdatingId(orderId);

      const order = await getOrderDetails(orderId);
      const items = Array.isArray(order.items) ? order.items : [];
      const insufficientItems = items.filter((item) => !isStockAvailable(item));

      if (insufficientItems.length > 0) {
        const itemDetails = insufficientItems
          .map((item) => {
            const name = escapeHtml(item.product_name || item.name || "Item");
            const quantity = escapeHtml(item.quantity || 0);
            const currentStock = escapeHtml(item.current_stock ?? item.stock ?? 0);

            return `${name}: Required ${quantity}, Available ${currentStock}`;
          })
          .join("\n");

        await Swal.fire({
          icon: "error",
          title: "Insufficient Stock",
          html: `
            <div style="text-align: left;">
              <p>Cannot approve this order because some items do not have enough stock.</p>
              <pre style="background: #f8f9fa; padding: 10px; border-radius: 8px; font-size: 12px; white-space: pre-wrap;">${itemDetails}</pre>
            </div>
          `,
          confirmButtonColor: "#ff5f93",
        });

        return;
      }

      const confirm = await Swal.fire({
        icon: "question",
        title: "Approve Order?",
        html: `
          <div style="text-align: left;">
            <p>Confirm approval for this customer order.</p>
            <p><strong>Order:</strong> #${escapeHtml(getOrderNumber(order))}</p>
            <p><strong>Customer:</strong> ${escapeHtml(getCustomerName(order))}</p>
            <p><strong>Total:</strong> ${escapeHtml(formatCurrency(order.total_amount))}</p>
            <p style="color: #10b981; font-weight: 700;">All listed items have sufficient stock.</p>
          </div>
        `,
        showCancelButton: true,
        confirmButtonText: "Approve Order",
        cancelButtonText: "Cancel",
        confirmButtonColor: "#10b981",
      });

      if (!confirm.isConfirmed) return;

      const result = await postOrderAction(
        `/receptionist/customer-orders/${orderId}/approve`
      );

      await Swal.fire({
        icon: "success",
        title: "Order Approved",
        text: `Order #${result?.order_number || getOrderNumber(order)} has been approved successfully. Stock has been deducted.`,
        timer: 2600,
        showConfirmButton: false,
      });

      setDetailsModalOpen(false);
      setSelectedOrder(null);
      await fetchOrders({ silent: true });
    } catch (err) {
      Swal.fire({
        icon: "error",
        title: "Approval Failed",
        text: err.message || "Failed to approve order.",
        confirmButtonColor: "#ff5f93",
      });
    } finally {
      setUpdatingId(null);
    }
  };

  const rejectOrder = async (orderId) => {
    const reason = await showReasonPrompt(
      "Please select a clear reason for rejecting this order.",
      "Reject Order",
      "Reject Order",
      ORDER_REASONS
    );

    if (!reason) return;

    try {
      setUpdatingId(orderId);

      const result = await postOrderAction(
        `/receptionist/customer-orders/${orderId}/reject`,
        {
          rejection_reason: reason,
        }
      );

      await Swal.fire({
        icon: "success",
        title: "Order Rejected",
        text: `Order #${result?.order_number || orderId} has been rejected.`,
        timer: 2600,
        showConfirmButton: false,
      });

      setDetailsModalOpen(false);
      setSelectedOrder(null);
      await fetchOrders({ silent: true });
    } catch (err) {
      Swal.fire({
        icon: "error",
        title: "Rejection Failed",
        text: err.message || "Failed to reject order.",
        confirmButtonColor: "#ff5f93",
      });
    } finally {
      setUpdatingId(null);
    }
  };

  const cancelOrder = async (orderId) => {
    const reason = await showReasonPrompt(
      "Please select a clear reason for cancelling this order.",
      "Cancel Order",
      "Cancel Order",
      ORDER_REASONS
    );

    if (!reason) return;

    try {
      setUpdatingId(orderId);

      const result = await postOrderAction(
        `/receptionist/customer-orders/${orderId}/cancel`,
        {
          cancellation_reason: reason,
        }
      );

      await Swal.fire({
        icon: "success",
        title: "Order Cancelled",
        text: `Order #${result?.order_number || orderId} has been cancelled. Stock was restored if applicable.`,
        timer: 2600,
        showConfirmButton: false,
      });

      setDetailsModalOpen(false);
      setSelectedOrder(null);
      await fetchOrders({ silent: true });
    } catch (err) {
      Swal.fire({
        icon: "error",
        title: "Cancellation Failed",
        text: err.message || "Failed to cancel order.",
        confirmButtonColor: "#ff5f93",
      });
    } finally {
      setUpdatingId(null);
    }
  };

  const viewOrderDetails = async (orderId) => {
    try {
      setDetailsModalOpen(true);
      setDetailsLoading(true);
      setSelectedOrder(null);

      const order = await getOrderDetails(orderId);
      setSelectedOrder(order);
    } catch (err) {
      setDetailsModalOpen(false);

      Swal.fire({
        icon: "error",
        title: "Unable to Load Order",
        text: err.message || "Failed to fetch order details.",
        confirmButtonColor: "#ff5f93",
      });
    } finally {
      setDetailsLoading(false);
    }
  };

  const exportColumns = [
    { key: "id", label: "Order ID" },
    { key: "orderNumber", label: "Order Number" },
    { key: "customer", label: "Customer" },
    { key: "email", label: "Email" },
    { key: "orderType", label: "Order Type" },
    { key: "totalAmount", label: "Total Amount" },
    { key: "paymentMethod", label: "Payment Method" },
    { key: "paymentStatus", label: "Payment Status" },
    { key: "status", label: "Status" },
    { key: "date", label: "Date" },
  ];

  const handleExport = (format) => {
    setShowExportDropdown(false);
    if (filteredOrders.length === 0) {
      Swal.fire({
        icon: "info",
        title: "No Orders to Export",
        text: "There are no matching customer orders to export.",
        confirmButtonColor: "#ff5f93",
      });
      return;
    }

    const exportData = filteredOrders.map((order) => ({
      id: order.id,
      orderNumber: order.order_number || order.reference_number || "",
      customer: getCustomerName(order),
      email: getCustomerEmail(order),
      orderType: order.order_type || "",
      totalAmount: order.total_amount || 0,
      paymentMethod: order.payment_method || "",
      paymentStatus: order.payment_status || "",
      status: order.status || "",
      date: order.created_at || "",
    }));

    const filename = "receptionist-customer-orders";
    if (format === "csv") exportToCSV(exportData, exportColumns, filename);
    else if (format === "excel") exportToExcel(exportData, exportColumns, filename);
    else if (format === "pdf") exportToPDF(exportData, exportColumns, "Customer Orders", filename);
  };

  const clearFilters = () => {
    setSearchTerm("");
    setStatusFilter("all");
    setPaymentStatusFilter("all");
  };

  const getStatusClass = (status) => {
    const value = normalizeStatus(status);

    if (["approved", "paid", "completed"].includes(value)) return "success";
    if (["pending", "preparing"].includes(value)) return "warning";
    if (["rejected", "cancelled"].includes(value)) return "danger";

    return "secondary";
  };

  const getPaymentClass = (status) => {
    const value = normalizePaymentStatus(status);

    if (value === "paid") return "success";
    if (value === "pending") return "info";
    if (value === "rejected") return "danger";

    return "warning";
  };

  const canApprove = (order) => normalizeStatus(order.status) === "pending";
  const canReject = (order) =>
    ["pending", "approved"].includes(normalizeStatus(order.status));
  const canCancel = (order) =>
    ["pending", "approved"].includes(normalizeStatus(order.status));

  return (
    <div className="customer-orders">
      <section className="orders-hero">
        <div>
          <span className="orders-eyebrow">
            <FontAwesomeIcon icon={faShoppingCart} />
            Receptionist Store Orders
          </span>

          <h1>Customer Order Approval</h1>

          <p>
            Review product orders, verify stock availability before approval,
            reject invalid orders, and cancel orders when needed.
          </p>

          <small>Last updated: {lastUpdated || "Not refreshed yet"}</small>
        </div>

        <div className="orders-hero-actions">
          <button
            type="button"
            className={`secondary-btn ${refreshing ? "loading" : ""}`}
            onClick={() => fetchOrders({ silent: true })}
            disabled={refreshing || loading}
          >
            <FontAwesomeIcon icon={refreshing ? faSpinner : faRefresh} spin={refreshing} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>

          <div className="export-dropdown-wrapper" style={{ position: "relative" }}>
            <button type="button" className="secondary-btn" onClick={() => setShowExportDropdown(!showExportDropdown)}>
              <FontAwesomeIcon icon={faDownload} />
              Export ▼
            </button>
            {showExportDropdown && (
              <>
                <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 998 }} onClick={() => setShowExportDropdown(false)} />
                <div style={{ position: "absolute", top: "100%", right: 0, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 999, minWidth: 160, overflow: "hidden" }}>
                  <button type="button" className="secondary-btn" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => handleExport("csv")}>Export as CSV</button>
                  <button type="button" className="secondary-btn" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => handleExport("excel")}>Export as Excel</button>
                  <button type="button" className="secondary-btn" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => handleExport("pdf")}>Export as PDF</button>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="orders-summary-grid">
        <button type="button" className="orders-summary-card" onClick={() => setStatusFilter("all")}>
          <span>
            <FontAwesomeIcon icon={faReceipt} />
          </span>
          <div>
            <strong>{stats.total}</strong>
            <p>Total Orders</p>
          </div>
        </button>

        <button
          type="button"
          className="orders-summary-card warning"
          onClick={() => setStatusFilter("pending")}
        >
          <span>
            <FontAwesomeIcon icon={faClipboardList} />
          </span>
          <div>
            <strong>{stats.pending}</strong>
            <p>Pending Approval</p>
          </div>
        </button>

        <button
          type="button"
          className="orders-summary-card info"
          onClick={() => setStatusFilter("approved")}
        >
          <span>
            <FontAwesomeIcon icon={faCheckCircle} />
          </span>
          <div>
            <strong>{stats.approved}</strong>
            <p>Approved</p>
          </div>
        </button>

        <button
          type="button"
          className="orders-summary-card success"
          onClick={() => setPaymentStatusFilter("paid")}
        >
          <span>
            <FontAwesomeIcon icon={faMoneyBillWave} />
          </span>
          <div>
            <strong>{stats.paid}</strong>
            <p>Paid Orders</p>
          </div>
        </button>

        <button type="button" className="orders-summary-card amount">
          <span>
            <FontAwesomeIcon icon={faWallet} />
          </span>
          <div>
            <strong>{formatCurrency(stats.totalAmount)}</strong>
            <p>Total Amount</p>
          </div>
        </button>
      </section>

      <section className="orders-controls">
        <div className="orders-search-box">
          <input
            type="text"
            placeholder="Search order ID, customer, email, payment, or type..."
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />

          {searchTerm && (
            <button type="button" onClick={() => setSearchTerm("")}>
              <FontAwesomeIcon icon={faTimes} />
            </button>
          )}
        </div>

        <label className="orders-filter-box">
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            {STATUS_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="orders-filter-box">
          <select
            value={paymentStatusFilter}
            onChange={(event) => setPaymentStatusFilter(event.target.value)}
          >
            {PAYMENT_STATUS_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <button type="button" className="clear-btn" onClick={clearFilters}>
          <FontAwesomeIcon icon={faTimes} />
          Clear
        </button>
      </section>

      <section className="orders-table-card">
        <div className="orders-table-header">
          <div>
            <span className="orders-eyebrow">
              <FontAwesomeIcon icon={faClipboardList} />
              Live Order Queue
            </span>

            <h2>Customer Orders</h2>

            <p>
              Showing <strong>{filteredOrders.length}</strong> of{" "}
              <strong>{orders.length}</strong> order(s).
            </p>
          </div>
        </div>

        {loading ? (
          <div className="orders-state">
            <FontAwesomeIcon icon={faSpinner} spin />
            <h3>Loading customer orders...</h3>
            <p>Please wait while the system loads live order data.</p>
          </div>
        ) : (
          <div className="orders-table-scroll">
            <table className="orders-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Total</th>
                  <th>Type</th>
                  <th>Payment</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>

              <tbody>
                {filteredOrders.length === 0 && (
                  <tr>
                    <td colSpan="8">
                      <div className="orders-empty-state">
                        <FontAwesomeIcon icon={faSearch} />
                        <h3>No matching orders found</h3>
                        <p>Try changing your search keyword or filters.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {filteredOrders.map((order) => {
                  const status = normalizeStatus(order.status);
                  const paymentStatus = normalizePaymentStatus(order.payment_status);
                  const busy = updatingId === order.id;

                  return (
                    <tr key={order.id}>
                      <td>
                        <div className="order-id-cell">
                          <span>#{getOrderNumber(order)}</span>
                          <small>ID: {order.id}</small>
                        </div>
                      </td>

                      <td>
                        <div className="customer-cell">
                          <span>
                            <FontAwesomeIcon icon={faUser} />
                          </span>
                          <div>
                            <strong>{getCustomerName(order)}</strong>
                            <small>
                              <FontAwesomeIcon icon={faEnvelope} />
                              {getCustomerEmail(order)}
                            </small>
                          </div>
                        </div>
                      </td>

                      <td>
                        <strong className="order-total">
                          {formatCurrency(order.total_amount)}
                        </strong>
                      </td>

                      <td>
                        <span className="order-type">
                          {formatLabel(order.order_type || "Pick-up")}
                        </span>
                      </td>

                      <td>
                        <div className="payment-cell">
                          <span className={`payment-badge ${getPaymentClass(paymentStatus)}`}>
                            {formatLabel(paymentStatus)}
                          </span>
                          <small>{order.payment_method || "No method"}</small>
                        </div>
                      </td>

                      <td>
                        <div className="date-cell">
                          <FontAwesomeIcon icon={faCalendarAlt} />
                          <span>{formatDate(order.created_at)}</span>
                        </div>
                      </td>

                      <td>
                        <span className={`status-badge ${getStatusClass(status)}`}>
                          {formatLabel(status)}
                        </span>
                      </td>

                      <td>
                        <RowActionPopover rowLabel={getOrderNumber(order)}>
                          <div className="order-actions">
                          <button
                            type="button"
                            className="action-btn view"
                            onClick={() => viewOrderDetails(order.id)}
                            disabled={busy}
                            title="View Details"
                          >
                            <FontAwesomeIcon icon={faEye} />
                          </button>

                          {canApprove(order) && (
                            <button
                              type="button"
                              className="action-btn approve"
                              onClick={() => approveOrder(order.id)}
                              disabled={busy}
                              title="Approve Order"
                            >
                              <FontAwesomeIcon icon={busy ? faSpinner : faCheckCircle} spin={busy} />
                            </button>
                          )}

                          {canReject(order) && (
                            <button
                              type="button"
                              className="action-btn reject"
                              onClick={() => rejectOrder(order.id)}
                              disabled={busy}
                              title="Reject Order"
                            >
                              <FontAwesomeIcon icon={faTimesCircle} />
                            </button>
                          )}

                          {canCancel(order) && (
                            <button
                              type="button"
                              className="action-btn cancel"
                              onClick={() => cancelOrder(order.id)}
                              disabled={busy}
                              title="Cancel Order"
                            >
                              <FontAwesomeIcon icon={faBan} />
                            </button>
                          )}

                          {status === "paid" && (
                            <span className="order-state-note">
                              <FontAwesomeIcon icon={faTruck} />
                              Ready for fulfillment
                            </span>
                          )}

                          {["rejected", "cancelled"].includes(status) && (
                            <span className="order-state-note muted">
                              {formatLabel(status)}
                            </span>
                          )}
                          </div>
                        </RowActionPopover>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {detailsModalOpen && (
        <div className="order-modal-overlay" onClick={() => setDetailsModalOpen(false)}>
          <div className="order-modal" onClick={(event) => event.stopPropagation()}>
            <div className="order-modal-header">
              <div>
                <span className="orders-eyebrow">
                  <FontAwesomeIcon icon={faEye} />
                  Order Details
                </span>

                <h2>
                  {detailsLoading || !selectedOrder
                    ? "Loading Order"
                    : `Order #${getOrderNumber(selectedOrder)}`}
                </h2>
              </div>

              <button
                type="button"
                className="close-modal-btn"
                onClick={() => setDetailsModalOpen(false)}
              >
                <FontAwesomeIcon icon={faTimes} />
              </button>
            </div>

            {detailsLoading || !selectedOrder ? (
              <div className="orders-state modal-state">
                <FontAwesomeIcon icon={faSpinner} spin />
                <h3>Loading order details...</h3>
                <p>Please wait while the order record is prepared.</p>
              </div>
            ) : (
              <>
                <div className="order-modal-body">
                  <div className="order-detail-grid">
                    <DetailItem label="Customer" value={getCustomerName(selectedOrder)} />
                    <DetailItem label="Email" value={getCustomerEmail(selectedOrder)} />
                    <DetailItem
                      label="Order Type"
                      value={formatLabel(selectedOrder.order_type || "Pick-up")}
                    />
                    <DetailItem
                      label="Total Amount"
                      value={formatCurrency(selectedOrder.total_amount)}
                    />
                    <DetailItem
                      label="Payment Method"
                      value={selectedOrder.payment_method || "N/A"}
                    />
                    <DetailItem
                      label="Payment Status"
                      value={formatLabel(selectedOrder.payment_status || "unpaid")}
                    />
                    <DetailItem label="Status" value={formatLabel(selectedOrder.status)} />
                    <DetailItem label="Created" value={formatDate(selectedOrder.created_at)} />
                  </div>

                  <div className="order-items-panel">
                    <div className="panel-heading">
                      <h3>Order Items</h3>
                      <p>Stock availability is checked before order approval.</p>
                    </div>

                    {Array.isArray(selectedOrder.items) && selectedOrder.items.length > 0 ? (
                      <div className="modal-items-list">
                        {selectedOrder.items.map((item, index) => {
                          const stockAvailable = isStockAvailable(item);

                          return (
                            <div key={item.id || index} className="modal-item-row">
                              <div>
                                <strong>{item.product_name || item.name || "Product"}</strong>
                                <small>
                                  Quantity: {item.quantity || 0} x{" "}
                                  {formatCurrency(item.price || item.unit_price)}
                                </small>
                              </div>

<div>
                                <strong>{formatCurrency(item.subtotal)}</strong>
                                <span
                                  className={`stock-badge ${
                                    stockAvailable ? "available" : "unavailable"
                                  }`}
                                >
                                  {stockAvailable
                                    ? `Stock: ${item.current_stock ?? item.stock ?? "Available"}`
                                    : `Low Stock: ${item.current_stock ?? item.stock ?? 0}`}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="modal-empty-items">
                        <FontAwesomeIcon icon={faShoppingCart} />
                        <p>No order items found.</p>
                      </div>
                    )}
                  </div>

                  {(selectedOrder.rejection_reason || selectedOrder.cancellation_reason) && (
                    <div className="order-reason-card">
                      <h3>Order Note</h3>
                      <p>
                        {selectedOrder.rejection_reason ||
                          selectedOrder.cancellation_reason ||
                          "No reason provided."}
                      </p>
                    </div>
                  )}
                </div>

                <div className="order-modal-actions">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => setDetailsModalOpen(false)}
                  >
                    Close
                  </button>

                  {canApprove(selectedOrder) && (
                    <button
                      type="button"
                      className="primary-btn"
                      onClick={() => approveOrder(selectedOrder.id)}
                      disabled={updatingId === selectedOrder.id}
                    >
                      <FontAwesomeIcon
                        icon={updatingId === selectedOrder.id ? faSpinner : faCheckCircle}
                        spin={updatingId === selectedOrder.id}
                      />
                      Approve
                    </button>
                  )}

                  {canReject(selectedOrder) && (
                    <button
                      type="button"
                      className="danger-btn"
                      onClick={() => rejectOrder(selectedOrder.id)}
                      disabled={updatingId === selectedOrder.id}
                    >
                      <FontAwesomeIcon icon={faTimesCircle} />
                      Reject
                    </button>
                  )}

                  {canCancel(selectedOrder) && (
                    <button
                      type="button"
                      className="warning-btn"
                      onClick={() => cancelOrder(selectedOrder.id)}
                      disabled={updatingId === selectedOrder.id}
                    >
                      <FontAwesomeIcon icon={faBan} />
                      Cancel
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const DetailItem = ({ label, value }) => (
  <div className="order-detail-item">
    <small>{label}</small>
    <strong>{value || "N/A"}</strong>
  </div>
);