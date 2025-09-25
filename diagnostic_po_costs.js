// Diagnostic function to check all costs on a PO
function diagnosePOCosts(purchaseOrder) {
    gs.info('=== DIAGNOSTIC: Checking all costs for PO ' + purchaseOrder.sys_id + ' ===');
    
    // Check ALL costs for this PO (no order_line filter)
    const allCosts = new GlideRecord('sn_shop_cost_allocation');
    allCosts.addQuery('x_supr2_supreme_ca_purchase_order', purchaseOrder.sys_id.toString());
    allCosts.query();
    
    gs.info('Total costs found: ' + allCosts.getRowCount());
    
    const costsByType = {
        poLevel: [],
        lineLevel: []
    };
    
    while (allCosts.next()) {
        const costInfo = {
            category: allCosts.getDisplayValue('x_supr2_supreme_ca_category'),
            amount: allCosts.getDisplayValue('allocation_amount'),
            hasOrderLine: !allCosts.order_line.nil(),
            orderLine: allCosts.order_line.toString(),
            sysId: allCosts.sys_id.toString()
        };
        
        if (costInfo.hasOrderLine) {
            costsByType.lineLevel.push(costInfo);
        } else {
            costsByType.poLevel.push(costInfo);
        }
        
        gs.info('Cost: ' + costInfo.category + 
                ' | Amount: ' + costInfo.amount + 
                ' | Has Order Line: ' + costInfo.hasOrderLine + 
                ' | Order Line: ' + (costInfo.orderLine || 'null'));
    }
    
    gs.info('--- Summary ---');
    gs.info('PO-level costs: ' + costsByType.poLevel.length);
    gs.info('Line-level costs: ' + costsByType.lineLevel.length);
    
    gs.info('PO-level categories: ' + costsByType.poLevel.map(c => c.category).join(', '));
    gs.info('Line-level categories: ' + costsByType.lineLevel.map(c => c.category).join(', '));
    
    return costsByType;
}